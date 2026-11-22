import path from "node:path";
import { describe, expect, it } from "vitest";
import { readFixture } from "../lib/catalog";
import { openPglite } from "../lib/db";
import { compareWithHolding } from "../lib/privacy";
import { getOffers, postRequest, type Deps } from "../lib/service";
import { handleMcpRequest } from "../mcp/http";
import { normalizeGtin, parseFreeText, parseNeed } from "../referee/parse";
import type { PublicOffer } from "../referee/types";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

async function setup() {
  const store = await openPglite();
  const variants = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;
  const deps: Deps = { store, loadVariants: async () => variants };
  return { store, deps };
}

describe("any product, no price", () => {
  it("accepts and stores a need with only text and no price", async () => {
    const { store, deps } = await setup();
    const posted = await postRequest({ text: "I'm looking for a Breville Barista Express espresso machine" }, deps);
    expect(posted.persisted).toBe(true);
    expect(posted.offers).toEqual([]);
    expect(posted.need.max_price_cents).toBeNull();
    expect(posted.need.model).toBe("Breville Barista Express espresso machine");
    const row = await store.getRequest(posted.id);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.need_json).max_price_cents).toBeNull();
    await store.close();
  });

  it("accepts a vague request and asks for a brand, model or barcode", async () => {
    const { store, deps } = await setup();
    const posted = await postRequest({ text: "I'm looking for these shoes" }, deps);
    expect(posted.persisted).toBe(true);
    expect(posted.hint).toMatch(/brand and model, or a barcode/);
    await store.close();
  });

  it("refuses an empty request", async () => {
    const { store, deps } = await setup();
    await expect(postRequest({}, deps)).rejects.toThrow(/Say what you are looking for/);
    await store.close();
  });

  it("takes structured fields: gtin, colour, attributes, quantity, category, country", async () => {
    const { store, deps } = await setup();
    const posted = await postRequest(
      {
        brand: "Sony",
        model: "WH-1000XM5",
        gtin: "4006381333931",
        color: "Black",
        attributes: { Edition: "2024" },
        quantity: 2,
        category: "Headphones",
        country: "IE",
      },
      deps,
    );
    expect(posted.need).toMatchObject({
      brand: "Sony",
      model: "WH-1000XM5",
      gtin: "4006381333931",
      color: "Black",
      attributes: { edition: "2024" },
      quantity: 2,
      category: "headphones",
      country: "IE",
    });
    await store.close();
  });

  it("validates gtin, quantity and attributes", async () => {
    const { store, deps } = await setup();
    await expect(postRequest({ text: "x", gtin: "4006381333932" }, deps)).rejects.toThrow(/check digit/);
    await expect(postRequest({ text: "x", quantity: 0 }, deps)).rejects.toThrow(/quantity/);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
    await expect(postRequest({ text: "x", attributes: many }, deps)).rejects.toThrow(/at most 10/);
    await store.close();
  });

  it("reads a barcode from free text and keeps the running-shoe parse", () => {
    expect(normalizeGtin("4006381333931")).toBe("4006381333931");
    expect(normalizeGtin("036000291452")).toBe("036000291452");
    expect(normalizeGtin("036000291453")).toBeNull();
    const fromText = parseFreeText("need barcode 4006381333931 please");
    expect(fromText.gtin).toBe("4006381333931");
    expect(fromText.model).not.toContain("4006381333931");
    const hoka = parseFreeText("I want to buy Hoka Clifton 9 size 10");
    expect(hoka.brand).toBe("Hoka");
    expect(hoka.model).toBe("Clifton 9");
    expect(hoka.size).toBe("10");
    const ghost = parseFreeText("women's Brooks Ghost 16, size 8, under $130");
    expect(ghost.model).toBe("Ghost 16");
    expect(ghost.max_price_cents).toBe(12999);
  });
});

describe("holding", () => {
  const holding = { seller: "Big Marketplace", price: 150, currency: "USD", delivered: false, delivery_by: inDays(5) };

  it("validates the held order", async () => {
    const { store, deps } = await setup();
    const base = { text: "women's Brooks Ghost 16, size 8" };
    await expect(postRequest({ ...base, holding: { ...holding, currency: "dollars" } }, deps)).rejects.toThrow(/currency/);
    await expect(postRequest({ ...base, holding: { ...holding, price: -1 } }, deps)).rejects.toThrow(/holding\.price/);
    await expect(postRequest({ ...base, holding: { seller: "x", currency: "USD" } }, deps)).rejects.toThrow(/holding\.price/);
    await expect(postRequest({ ...base, holding: { ...holding, delivery_by: "2026-02-30" } }, deps)).rejects.toThrow(/not a real date/);
    await expect(postRequest({ ...base, holding: { ...holding, delivery_by: "2001-01-01" } }, deps)).rejects.toThrow(/in the past/);
    await expect(postRequest({ ...base, holding: { ...holding, delivery_by: "next week" } }, deps)).rejects.toThrow(/delivery_by/);
    await expect(postRequest({ ...base, holding: { ...holding, card: "4111" } }, deps)).rejects.toThrow(/not valid/);
    await store.close();
  });

  it("stores the holding and says whether each offer beats it, to the poster only", async () => {
    const { store, deps } = await setup();
    const posted = await postRequest({ text: "women's Brooks Ghost 16, size 8", holding }, deps);
    expect(posted.need.holding).toEqual({
      seller: "Big Marketplace",
      price_cents: 15000,
      currency: "USD",
      delivered: false,
      delivery_by: holding.delivery_by,
    });
    expect(posted.offers[0]?.price_cents).toBe(11995);
    expect(posted.offers.every((offer) => offer.vs_holding != null)).toBe(true);
    expect(posted.offers[0]?.vs_holding).toMatchObject({ beats: true, by_cents: 3005, by: "30.05", currency: "USD" });

    const stored = JSON.parse((await store.getRequest(posted.id))!.need_json);
    expect(stored.holding.price_cents).toBe(15000);

    const mine = await getOffers({ request_id: posted.id, delete_token: posted.delete_token }, deps);
    expect(mine.view).toBe("poster");
    expect(mine.offers[0]?.vs_holding?.beats).toBe(true);

    const theirs = await getOffers({ request_id: posted.id }, deps);
    expect(theirs.view).toBe("public");
    expect(theirs.offers[0]?.vs_holding).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain("Big Marketplace");

    const wrong = await getOffers({ request_id: posted.id, delete_token: "x".repeat(43) }, deps);
    expect(wrong.view).toBe("public");
    await store.close();
  });

  it("compares totals for a quantity, and does not compare across currencies", () => {
    const offer = {
      price: "119.95",
      price_cents: 11995,
      currency: "USD",
      available: true,
      shipping: null,
      delivery_days: null,
    } as PublicOffer;
    const two = compareWithHolding(offer, { seller: null, price_cents: 20000, currency: "USD", delivered: true, delivery_by: null }, 2);
    expect(two.beats).toBe(false);
    expect(two.by_cents).toBe(-3990);
    expect(two.note).toMatch(/2 x 119.95/);
    expect(two.note).toMatch(/includes delivery/);
    const other = compareWithHolding(offer, { seller: null, price_cents: 20000, currency: "GBP", delivered: false, delivery_by: null }, 1);
    expect(other.beats).toBeNull();
    expect(other.by).toBeNull();
    expect(parseNeed({ text: "x", holding: { price: 10, currency: "eur" } }).holding?.currency).toBe("EUR");
  });
});

describe("mcp tools", () => {
  async function mcp(deps: Deps, method: string, params: unknown) {
    const response = await handleMcpRequest(
      new Request("http://haggleboard.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      deps,
    );
    return (await response.json()) as { result: { tools?: Array<{ name: string; description: string }>; content?: Array<{ text: string }>; isError?: boolean } };
  }

  it("post_request works with just text, and each tool says when to call it with one example", async () => {
    const { store, deps } = await setup();
    const tools = (await mcp(deps, "tools/list", {})).result.tools!;
    for (const tool of tools) {
      expect(tool.description).toMatch(/^Call this/);
      expect(tool.description).toMatch(/Example: \{/);
      expect(tool.description).not.toMatch(/—/);
    }
    const posted = await mcp(deps, "tools/call", { name: "post_request", arguments: { text: "Brooks Ghost 16 women's size 8" } });
    expect(posted.result.isError).toBeUndefined();
    const body = JSON.parse(posted.result.content![0]!.text);
    expect(body.persisted).toBe(true);
    expect(body.delete_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.offers[0].checkout).toBe("store_site");

    const withHolding = await mcp(deps, "tools/call", {
      name: "post_request",
      arguments: { text: "Brooks Ghost 16 women's size 8", holding: { price: 100, currency: "USD" } },
    });
    const held = JSON.parse(withHolding.result.content![0]!.text);
    expect(held.offers[0].vs_holding).toMatchObject({ beats: false, by: "-19.95" });
    await store.close();
  });
});
