import type { NeedInput } from "../referee/types.js";

export type BoardQuestion = {
  slug: string;
  title: string;
  need: NeedInput;
};

export const questions: BoardQuestion[] = [
  {
    slug: "womens-asics-novablast-6-size-7",
    title: "Women's ASICS Novablast 6 in size 7",
    need: {
      text: "women's ASICS Novablast 6, size 7",
      brand: "ASICS",
      model: "Novablast 6",
      gender: "women",
      size: "7",
    },
  },
  {
    slug: "mens-nike-structure-26-size-10",
    title: "Men's Nike Structure 26 in size 10",
    need: { text: "men's Nike Structure 26, size 10", brand: "Nike", model: "Structure 26", gender: "men", size: "10" },
  },
  {
    slug: "womens-oofos-oolala-luxe-thong-size-8",
    title: "Women's OOFOS Oolala Luxe Thong in size 8",
    need: {
      text: "women's OOFOS Oolala Luxe Thong, size 8",
      brand: "OOFOS",
      model: "Oolala Luxe Thong",
      gender: "women",
      size: "8",
    },
  },
  {
    slug: "womens-saucony-endorphin-speed-6-size-8",
    title: "Women's Saucony Endorphin Speed 6 in size 8",
    need: {
      text: "women's Saucony Endorphin Speed 6, size 8",
      brand: "Saucony",
      model: "Endorphin Speed 6",
      gender: "women",
      size: "8",
    },
  },
];

export function questionBySlug(slug: string): BoardQuestion | undefined {
  return questions.find((question) => question.slug === slug);
}
