import { describe, expect, it } from "vitest";
import { categorize, detectGender, parseSize, sizesMatch } from "../referee/attributes";
import { canonicalBrand, findBrandInText } from "../referee/brands";
import { matchVariants } from "../referee/match";
import { parseFreeText, parseNeed } from "../referee/parse";
import { rankOffers } from "../referee/rank";
import { toPublicOffer } from "../lib/service";
import type { CatalogVariant, PublicOffer } from "../referee/types";
import { USER_AGENT } from "../lib/copy";

function variant(over: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    id: "example-run.test:1",
    store_domain: "example-run.test",
    shop_origin: "https://example-run.test",
    country: "US",
    region: "US",
    brand: "Brooks",
    model: "Ghost 16",
    title: "Brooks Ghost 16",
    gender: "women",
    size: "8",
    size_raw: "8",
    size_system: "US",
    size_men: null,
    size_women: null,
    width: null,
    color: "Black",
    available: true,
    price: "119.95",
    price_cents: 11995,
    compare_at_price: "140.00",
    compare_at_cents: 14000,
    currency: "USD",
    product_url: "https://example-run.test/products/brooks-ghost-16?variant=1",
    handle: "brooks-ghost-16",
    external_product_id: "1",
    external_variant_id: "1",
    category: "shoe",
    observed_at: "2026-10-18T00:00:00.000Z",
    ...over,
  };
}

describe("identity", () => {
  it("uses the required crawler agent", () => {
    expect(USER_AGENT).toBe("HaggleBoard-bot/0.1 (+https://haggleboard.com/bot; contact@haggleboard.com)");
  });
});

describe("parse", () => {
  it("reads the running-shoe examples", () => {
    const ghost = parseFreeText("women's Brooks Ghost 16, size 8, under $130");
    expect(ghost.brand).toBe("Brooks");
    expect(ghost.model).toBe("Ghost 16");
    expect(ghost.gender).toBe("women");
    expect(ghost.size).toBe("8");
    expect(ghost.currency).toBe("USD");
    expect(ghost.max_price_cents).toBe(12999);

    const hoka = parseFreeText("cheapest Hoka Clifton 9 in size 10");
    expect(hoka.brand).toBe("Hoka");
    expect(hoka.model).toBe("Clifton 9");
    expect(hoka.size).toBe("10");

    const pegasus = parseFreeText("men's Nike Pegasus under £120");
    expect(pegasus.gender).toBe("men");
    expect(pegasus.brand).toBe("Nike");
    expect(pegasus.model).toBe("Pegasus");
    expect(pegasus.currency).toBe("GBP");
    expect(pegasus.max_price_cents).toBe(11999);
  });

  it("lets structured fields override free text", () => {
    const need = parseNeed({ text: "women's Brooks Ghost 16, size 8, under $130", size: "9.0", max_price: 100 });
    expect(need.size).toBe("9");
    expect(need.max_price_cents).toBe(10000);
    expect(need.brand).toBe("Brooks");
  });

  it("knows Hoka and On Cloud", () => {
    expect(canonicalBrand("HOKA ONE ONE")).toBe("Hoka");
    expect(findBrandInText("On Cloudmonster size 10")?.name).toBe("On");
  });
});

describe("attributes", () => {
  it("does not treat women as men", () => {
    expect(detectGender("Women's Ghost")).toBe("women");
    expect(detectGender("Men's Ghost")).toBe("men");
  });

  it("splits combined sizes and keeps widths", () => {
    const split = parseSize("M8 / W9.5");
    expect(split.men).toBe("8");
    expect(split.women).toBe("9.5");
    const width = parseSize("8 D");
    expect(width.size).toBe("8");
    expect(width.width).toBe("D");
    expect(sizesMatch({ size: "9.5", size_men: "8", size_women: "9.5", size_raw: "M8 / W9.5" }, "8", "women")).toBe(
      false,
    );
    expect(sizesMatch({ size: "9.5", size_men: "8", size_women: "9.5", size_raw: "M8 / W9.5" }, "9.5", "women")).toBe(
      true,
    );
  });

  it("keeps shoes and drops socks", () => {
    expect(categorize({ title: "Ghost 16", productType: "Road", tags: "" }, true)).toBe("shoe");
    expect(categorize({ title: "Hidden Comfort", productType: "Socks", tags: "" }, true)).toBe("other");
    expect(
      categorize(
        {
          title: "Men's CoolGrid Training Singlet",
          productType: "Running Shoes",
          tags: "New Shoes Apparel Type:Tops department:Running Footwear",
        },
        false,
      ),
    ).toBe("other");
    expect(
      categorize({ title: "Shokz OpenDots 2", productType: "Electronics", tags: "Headphones Accessories" }, false),
    ).toBe("other");
  });
});

describe("match and rank", () => {
  const catalog = [
    variant(),
    variant({
      id: "b",
      store_domain: "example-road.test",
      price: "140.00",
      price_cents: 14000,
      compare_at_cents: null,
      compare_at_price: null,
      product_url: "https://example-road.test/products/brooks-ghost-16?variant=2",
    }),
    variant({ id: "c", model: "Ghost 17", title: "Ghost 17", product_url: "https://example-run.test/products/g17?variant=3" }),
    variant({ id: "d", gender: "men", product_url: "https://example-run.test/products/mens?variant=4" }),
    variant({ id: "e", category: "other", title: "Socks", model: "Ghost 16", product_url: "https://example-run.test/s?variant=5" }),
    variant({ id: "f", available: false, price_cents: 1000, price: "10.00", product_url: "https://example-run.test/sold?variant=6" }),
    variant({
      id: "g",
      brand: "Hoka",
      model: "Clifton 10",
      title: "Clifton 10",
      product_url: "https://example-run.test/c10?variant=7",
    }),
  ];

  it("filters brand, model version, gender, size, and price", () => {
    const need = parseNeed({ text: "women's Brooks Ghost 16, size 8, under $130" });
    const hits = matchVariants(catalog, need);
    expect(hits.map((hit) => hit.id)).toEqual(["example-run.test:1"]);
  });

  it("does not match Clifton 10 for Clifton 9", () => {
    const need = parseNeed({ brand: "Hoka", model: "Clifton 9", size: "10" });
    expect(matchVariants(catalog, need)).toHaveLength(0);
  });

  it("ranks cheaper available offers first and ignores paid placement", () => {
    const offers: PublicOffer[] = [
      toPublicOffer(variant({ price_cents: 13000, price: "130.00", store_domain: "b.example", product_url: "https://b.example/p?variant=2" }), "feed"),
      toPublicOffer(variant({ price_cents: 10000, price: "100.00", available: false, product_url: "https://example-run.test/p?variant=9" }), "feed"),
      toPublicOffer(variant(), "feed"),
    ];
    const ranked = rankOffers(offers);
    expect(ranked[0]?.price_cents).toBe(11995);
    expect(ranked[0]?.available).toBe(true);
    expect(ranked.at(-1)?.available).toBe(false);
  });
});
