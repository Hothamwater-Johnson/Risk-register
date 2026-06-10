import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LEARN_PAGES } from "@/lib/explain/copy";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return Object.keys(LEARN_PAGES).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = LEARN_PAGES[slug];
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function LearnPage({ params }: Props) {
  const { slug } = await params;
  const page = LEARN_PAGES[slug];
  if (!page) notFound();

  return (
    <article className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{page.title}</h1>
      {page.body.map((para, i) => (
        <p key={i} className="text-sm leading-relaxed text-muted">
          {para}
        </p>
      ))}
      <p className="border-t border-border pt-4 text-sm">
        <Link href="/" className="text-accent underline">
          See today&apos;s biggest cross-market gaps →
        </Link>
      </p>
    </article>
  );
}
