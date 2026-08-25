export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-8 font-sans dark:bg-black">
      <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
        webdev
      </h1>
      <p className="max-w-md text-center text-lg leading-8 text-zinc-600 dark:text-zinc-400">
        Your web development playground — Next.js, TypeScript, and Tailwind
        CSS.
      </p>
      <p className="text-sm text-zinc-500">
        Edit{" "}
        <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono dark:bg-white/[.08]">
          src/app/page.tsx
        </code>{" "}
        to start building.
      </p>
    </main>
  );
}
