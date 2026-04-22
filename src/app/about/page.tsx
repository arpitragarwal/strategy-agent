import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About · AI Strategy Team",
  description:
    "Product vision for the AI corporate strategy team — and the agent pipeline that delivers it.",
};

type Agent = {
  id: string;
  name: string;
  role: string;
};

type Capability = {
  id: string;
  label: string;
  body: string;
};

const AGENTS: Agent[] = [
  {
    id: "planner",
    name: "Planner agent",
    role: "Breaks down vague and complex questions into a structured analysis plan.",
  },
  {
    id: "researcher",
    name: "Research agent",
    role: "Searches across company data and institutional memory for relevant evidence.",
  },
  {
    id: "analysts",
    name: "Analyst agents",
    role: "Run quantitative and qualitative analysis against the plan.",
  },
  {
    id: "synthesizer",
    name: "Synthesis agent",
    role: "Synthesize the findings into a board-ready recommendation.",
  },
];

const CAPABILITIES: Capability[] = [
  {
    id: "long-horizon",
    label: "Long-horizon",
    body: "This architecture enables long, complex analysis while staying aligned with the original task, avoiding hallucination, and maintaining runtime stability.",
  },
  {
    id: "memory",
    label: "Memory",
    body: "Step outputs are saved to a SQL database, letting agents optionally reuse insights from prior runs.",
  },
  {
    id: "parallel",
    label: "Parallel execution",
    body: "Independent branches of the hypothesis tree run concurrently.",
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 sm:py-12">
      <nav className="mb-12">
        <a
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-emerald-800/90 hover:text-emerald-700 underline-offset-2 hover:underline"
        >
          <span aria-hidden>←</span>
          <span>Back to app</span>
        </a>
      </nav>

      <section>
        <Block eyebrow="What it is">
          <p className="text-lg leading-relaxed text-zinc-800">
            The product is a team of AI agents that supercharges a corporate
            strategy team&apos;s knowledge work, allowing every member to
            operate a level higher and focus on people work.
          </p>
        </Block>

        <Block eyebrow="What it does" className="mt-12">
          <p className="text-lg leading-relaxed text-zinc-800">
            Receive a board-ready analysis for any strategy question in hours
            instead of weeks, grounded in the company&apos;s own data and
            institutional memory.
          </p>
        </Block>

        <Block eyebrow="How it works" className="mt-16">
          <PipelineDiagram />
        </Block>

        <Block eyebrow="Built for" className="mt-16">
          <div className="grid gap-8 sm:grid-cols-3">
            {CAPABILITIES.map((cap) => (
              <div key={cap.id}>
                <p className="text-sm font-semibold text-zinc-900">
                  {cap.label}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
                  {cap.body}
                </p>
              </div>
            ))}
          </div>
        </Block>
      </section>
    </main>
  );
}

function Block({
  eyebrow,
  className,
  children,
}: {
  eyebrow: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
        {eyebrow}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function PipelineDiagram() {
  return (
    <div className="space-y-4">
      <ManagerCard />

      <div className="grid gap-4 sm:grid-cols-4">
        {AGENTS.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function ManagerCard() {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-zinc-900">Manager agent</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-600">
        Pressure-tests the output at every step.
      </p>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-zinc-900">{agent.name}</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-600">
        {agent.role}
      </p>
    </div>
  );
}
