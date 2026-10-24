import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OfferList } from "../../../components/offer-list";
import { questionBySlug, questions } from "../../../lib/questions";
import { defaultDeps, getOffers } from "../../../lib/service";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return questions.map((question) => ({ slug: question.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const question = questionBySlug(slug);
  return { title: question?.title ?? "Question" };
}

export default async function QuestionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const question = questionBySlug(slug);
  if (!question) notFound();
  const result = await getOffers(question.need, await defaultDeps());

  return (
    <main>
      <section className="hero">
        <p className="kicker">Question</p>
        <h1>{question.title}</h1>
        <p className="lede">
          Ranked from the public snapshot. The lowest price in a currency is first. HaggleBoard does not convert
          currencies and does not sell placement.
        </p>
      </section>
      <OfferList offers={result.offers} omitted={result.omitted_unavailable} />
      <p className="meta">
        <a href="/">Back to the board</a>
      </p>
    </main>
  );
}
