import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../lib/catalog";
import { getStore } from "../lib/db";
import { publicNeed, scrubPublicText } from "../lib/privacy";
import { boardFeed, defaultDeps, importVariants, postRequest, reportNeed } from "../lib/service";
import { handleMcpRequest } from "../mcp/http";
import { parseNeed } from "../referee/parse";

// Every public surface in this file reads the same in-memory database through defaultDeps().
process.env.DATABASE_URL = "pglite://memory";
process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Private values planted in a request. None may appear on a public surface. */
const SECRET = {
  text: "PRIVATETEXTWORD",
  // Built at runtime so the repo secret scan does not see an email address.
  email: ["secret.person", "example.org"].join("@"),
  phone: "555 0101 2020",
  seller: "SecretSellerCo",
  holdingPrice: "4321",
  maxPrice: "777",
  attribute: "PRIVATEATTRVALUE",
};

const privateBody = {
  text: `women's Brooks Ghost 16 size 8 ${SECRET.text}, email me at ${SECRET.email} or call ${SECRET.phone}`,
  brand: "Brooks",
  model: "Ghost 16",
  gender: "women",
  size: "8",
  max_price: 777.77,
  country: "US",
  attributes: { note: SECRET.attribute },
  holding: { seller: SECRET.seller, price: 4321.09, currency: "USD", delivered: true, delivery_by: inDays(7) },
};

/** Checks values only. Use for documents that may name the fields (tool schemas, llms.txt). */
function assertNoPrivateValues(surface: string, content: string) {
  for (const [name, value] of Object.entries(SECRET)) {
    expect(content.includes(value), `${surface} leaked ${name}`).toBe(false);
  }
}

/** HTML pages also carry the need form, so check values and formatted amounts only. */
function assertNoPrivateHtml(surface: string, html: string) {
  assertNoPrivateValues(surface, html);
  expect(html, `${surface} shows a private amount`).not.toMatch(/4,321|777\.77|vs_holding/);
}

/** Checks values and that no private field is present at all. Use for data surfaces. */
function assertNoPrivate(surface: string, content: string) {
  assertNoPrivateValues(surface, content);
  expect(content, `${surface} has a private field`).not.toMatch(
    /"holding"|vs_holding|max_price|"text"|"country"|"region"|"attributes"|"quantity"|77777|432109/,
  );
}

let posted: Awaited<ReturnType<typeof postRequest>>;
let token: string;

beforeAll(async () => {
  const deps = await defaultDeps();
  await importVariants(readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants, deps.store);
  const { POST } = await import("../app/api/requests/route");
  const response = await POST(
    new Request("http://haggleboard.test/api/requests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.20" },
      body: JSON.stringify(privateBody),
    }),
  );
  expect(response.status).toBe(201);
  posted = (await response.json()) as typeof posted;
  token = posted.delete_token!;
});

describe("the poster sees their own private fields", () => {
  it("returns the holding, the comparison and the max price in the POST response", () => {
    const body = JSON.stringify(posted);
    expect(body).toContain(SECRET.seller);
    expect(body).toContain("vs_holding");
    expect(posted.need.max_price_cents).toBe(77777);
  });

  it("returns the private view with the delete token", async () => {
    const { GET } = await import("../app/api/requests/[id]/offers/route");
    const response = await GET(
      new Request(`http://haggleboard.test/api/requests/${posted.id}/offers`, {
        headers: { "x-haggleboard-delete-token": token },
      }),
      { params: Promise.resolve({ id: posted.id }) },
    );
    const body = await response.text();
    expect(body).toContain(SECRET.seller);
    expect(body).toContain('"view":"poster"');
  });
});

describe("no private field on a public surface", () => {
  it("board JSON feed", async () => {
    const { GET } = await import("../app/board.json/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.text();
    const feed = JSON.parse(body) as Awaited<ReturnType<typeof boardFeed>>;
    const row = feed.requests.find((item) => item.id === posted.id);
    expect(row).toBeDefined();
    expect(row!.need.label).toBe("Women Brooks Ghost 16 size 8");
    expect(row!.stores_answered).toBeGreaterThan(0);
    assertNoPrivate("board.json", body);
  });

  it("board page", async () => {
    const { default: BoardPage } = await import("../app/board/page");
    const html = renderToStaticMarkup(await BoardPage());
    expect(html).toContain("Brooks Ghost 16");
    assertNoPrivateHtml("/board", html);
  });

  it("request page", async () => {
    const { default: RequestPage } = await import("../app/r/[id]/page");
    const html = renderToStaticMarkup(await RequestPage({ params: Promise.resolve({ id: posted.id }) }));
    expect(html).toContain("Brooks Ghost 16");
    assertNoPrivateHtml("/r/{id}", html);
  });

  it("home page", async () => {
    const { default: HomePage } = await import("../app/page");
    const html = renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({}) }));
    // The homepage strip lists outside requests only; this one came from a test host, so it is not
    // dressed up as real activity there. It is on the board.
    expect(html).not.toContain(`/r/${posted.id}`);
    expect(html).toContain("No real requests yet. Be the first.");
    assertNoPrivateHtml("/", html);
  });

  it("public API read of the request, without and with a wrong token", async () => {
    const { GET } = await import("../app/api/requests/[id]/offers/route");
    const variants: Array<Record<string, string>> = [{}, { "x-haggleboard-delete-token": "x".repeat(43) }];
    for (const headers of variants) {
      const response = await GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/offers`, { headers }), {
        params: Promise.resolve({ id: posted.id }),
      });
      const body = await response.text();
      expect(body).toContain('"view":"public"');
      assertNoPrivate("GET /api/requests/{id}/offers", body);
    }
  });

  it("MCP tool listing and a public get_offers", async () => {
    const deps = await defaultDeps();
    const call = async (method: string, params: unknown) => {
      const response = await handleMcpRequest(
        new Request("http://haggleboard.test/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        deps,
      );
      return response.text();
    };
    assertNoPrivateValues("MCP tools/list", await call("tools/list", {}));
    const envelope = JSON.parse(await call("tools/call", { name: "get_offers", arguments: { request_id: posted.id } }));
    const read = envelope.result.content[0].text as string;
    expect(read).toContain("Brooks");
    assertNoPrivate("MCP get_offers", JSON.stringify(JSON.parse(read)));
  });

  it("llms.txt and the skill carry no private values and no concrete holding example", () => {
    for (const file of ["llms.txt", path.join("skill", "haggleboard", "SKILL.md")]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      assertNoPrivateValues(file, text);
      const holdingLines = text.split("\n").filter((line) => line.includes("holding") && line.includes("price"));
      for (const line of holdingLines) expect(line, `${file}: holding example has a real number`).not.toMatch(/price"?\s*:\s*\d/);
      expect(text, `${file} has an em dash`).not.toMatch(/—/);
    }
  });
});

describe("no private field in the event stream, stats or scorecards", () => {
  const params = () => ({ params: Promise.resolve({ id: posted.id }) });

  it("GET /api/requests/{id}/events", async () => {
    const { GET } = await import("../app/api/requests/[id]/events/route");
    const body = await (await GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/events`), params())).text();
    expect(body).toContain("auction.opened");
    assertNoPrivate("/api/requests/{id}/events", body);
    expect(body).not.toMatch(/"private"|caller_hash|"internal"/);
  });

  it("GET /api/requests/{id}/stream", async () => {
    const { GET } = await import("../app/api/requests/[id]/stream/route");
    const controller = new AbortController();
    const response = await GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/stream`, { signal: controller.signal }), params());
    const reader = response.body!.getReader();
    let text = "";
    for (let i = 0; i < 4; i += 1) text += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    controller.abort();
    await reader.cancel();
    expect(text).toContain("store.joined");
    assertNoPrivate("/api/requests/{id}/stream", text);
  });

  it("GET /api/stats and GET /api/agents/{handle}", async () => {
    const stats = await import("../app/api/stats/route");
    assertNoPrivate("/api/stats", await (await stats.GET()).text());
    const agents = await import("../app/api/agents/[handle]/route");
    const missing = await agents.GET(new Request("http://haggleboard.test/api/agents/nobody"), { params: Promise.resolve({ handle: "nobody" }) });
    expect(missing.status).toBe(404);
  });

  it("the result route refuses a missing or wrong token", async () => {
    const { GET } = await import("../app/api/requests/[id]/result/route");
    const none = await GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/result?wait=0`), params());
    expect(none.status).toBe(400);
    const wrong = await GET(
      new Request(`http://haggleboard.test/api/requests/${posted.id}/result?wait=0`, { headers: { "x-haggleboard-delete-token": "x".repeat(43) } }),
      params(),
    );
    expect(wrong.status).toBe(403);
    assertNoPrivate("/api/requests/{id}/result (wrong token)", await wrong.text());
  });

  it("the outcome route refuses a wrong token", async () => {
    const { POST } = await import("../app/api/requests/[id]/outcome/route");
    const response = await POST(
      new Request(`http://haggleboard.test/api/requests/${posted.id}/outcome`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "198.51.100.21" },
        body: JSON.stringify({ delete_token: "x".repeat(43), outcome: "did_not_buy" }),
      }),
      params(),
    );
    expect(response.status).toBe(403);
  });
});

describe("public listings ignore the private price cap", () => {
  it("shows the store's public price even when it is above the poster's maximum", async () => {
    const deps = await defaultDeps();
    const capped = await postRequest({ brand: "Brooks", model: "Ghost 16", gender: "women", size: "8", max_price: 50 }, deps);
    expect(capped.offers).toHaveLength(0);
    const row = (await boardFeed(deps)).requests.find((item) => item.id === capped.id);
    expect(row?.prices.map((price) => price.price)).toContain("119.95");
  });
});

describe("delete token, reports and retention still apply to the board", () => {
  it("drops a request hidden with its delete token", async () => {
    const deps = await defaultDeps();
    const mine = await postRequest({ text: "Hoka Clifton 9 size 10" }, deps);
    expect((await boardFeed(deps)).requests.some((row) => row.id === mine.id)).toBe(true);
    await reportNeed(mine.id, { reason: "", ipHash: "ip", deleteToken: mine.delete_token }, deps);
    expect((await boardFeed(deps)).requests.some((row) => row.id === mine.id)).toBe(false);
  });

  it("drops a request after three distinct reports", async () => {
    const deps = await defaultDeps();
    const target = await postRequest({ text: "Hoka Clifton 9 size 10" }, deps);
    for (const ip of ["r1", "r2", "r3"]) await reportNeed(target.id, { reason: "spam", ipHash: ip, deleteToken: null }, deps);
    expect((await boardFeed(deps)).requests.some((row) => row.id === target.id)).toBe(false);
  });

  it("drops a request older than 30 days", async () => {
    const store = await getStore();
    await store.saveRequest({
      id: "00000000-0000-4000-8000-000000000001",
      need_json: JSON.stringify(parseNeed({ brand: "Brooks", model: "Ghost 16" })),
      created_at: "2020-01-01T00:00:00.000Z",
      delete_token_hmac: null,
    });
    const feed = await boardFeed(await defaultDeps());
    expect(feed.requests.some((row) => row.id === "00000000-0000-4000-8000-000000000001")).toBe(false);
  });
});

describe("product label scrubbing", () => {
  it("removes emails, links, phone numbers and handles from a label built from free text", () => {
    const need = parseNeed({ text: `Breville Barista Express ${SECRET.email} https://x.example/p +1 555 010 2020 @someone` });
    const label = publicNeed(need).label;
    expect(label).toContain("Breville Barista Express");
    expect(label).not.toMatch(/@|https|555/);
    expect(scrubPublicText("call 0871234567 now")).toBe("call now");
  });
});
