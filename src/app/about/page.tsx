import { Fragment } from "react";
import Link from "next/link";
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
    role: "Creates a structured analysis plan",
  },
  {
    id: "researcher",
    name: "Research agent",
    role: "Finds relevant data",
  },
  {
    id: "analysts",
    name: "Analyst agents",
    role: "In-depth quantitative and qualitative analysis",
  },
  {
    id: "synthesizer",
    name: "Synthesis agent",
    role: "Synthesize into recommendations",
  },
];

const CAPABILITIES: Capability[] = [
  {
    id: "long-horizon",
    label: "Long-horizon",
    body: "Execute complex analysis while staying aligned with the original task, avoiding hallucination, and maintaining runtime stability",
  },
  {
    id: "memory",
    label: "Memory",
    body: "Step outputs are saved to a SQL database, letting agents optionally reuse insights from prior runs",
  },
  {
    id: "parallel",
    label: "Parallel execution",
    body: "Independent branches of the hypothesis tree run concurrently",
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8 sm:py-10">
      <nav className="mb-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-emerald-800/90 hover:text-emerald-700 underline-offset-2 hover:underline"
        >
          <span aria-hidden>←</span>
          <span>Back to app</span>
        </Link>
      </nav>

      <section>
        <Block eyebrow="What it is">
          <p className="text-base leading-relaxed text-zinc-800">
            A team of AI agents that supercharges a corporate strategy
            team&apos;s knowledge work, allowing every member to operate a
            level higher and focus on people work.
          </p>
        </Block>

        <Block eyebrow="What it does: North Star" className="mt-8">
          <p className="text-base leading-relaxed text-zinc-800">
            Receive a board-ready analysis for any strategy question in hours
            instead of weeks, grounded in the company&apos;s own data and
            institutional memory.
          </p>
        </Block>

        <Block eyebrow="How it works" className="mt-10">
          <PipelineDiagram />
        </Block>

        <Block eyebrow="Capabilities" className="mt-10">
          <div className="grid gap-8 sm:grid-cols-3">
            {CAPABILITIES.map((cap) => (
              <div key={cap.id} className="flex items-start gap-2">
                <CheckIcon className="mt-0.5 h-4 w-4 flex-none text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900">
                    {cap.label}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
                    {cap.body}
                  </p>
                </div>
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
      <div className="mt-2">{children}</div>
    </div>
  );
}

function PipelineDiagram() {
  return (
    <>
      <MobilePipeline />
      <DesktopPipeline />
    </>
  );
}

function MobilePipeline() {
  return (
    <div className="flex flex-col sm:hidden">
      <ManagerCard />
      <VerticalConnector />
      {AGENTS.map((agent, i) => (
        <Fragment key={agent.id}>
          <AgentCard agent={agent} />
          {i < AGENTS.length - 1 && <VerticalConnector />}
        </Fragment>
      ))}
      <VerticalConnector />
      <DataCard />
    </div>
  );
}

function DesktopPipeline() {
  return (
    <div className="hidden sm:block">
      <div
        className="mx-auto"
        style={{ width: "calc((100% - 1rem) / 2)" }}
      >
        <ManagerCard />
      </div>
      <ManagerToAgentsConnector />
      <div className="grid gap-4 sm:grid-cols-4">
        {AGENTS.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
      <AgentsToDataConnector />
      <DataCard />
    </div>
  );
}

function VerticalConnector() {
  return (
    <div aria-hidden className="flex h-5 justify-center">
      <div className="h-full w-px bg-emerald-300" />
    </div>
  );
}

function ManagerToAgentsConnector() {
  const columnLeft = (i: number) =>
    `calc((100% - 3rem) / 8 + ${i} * ((100% - 3rem) / 4 + 1rem))`;
  return (
    <div aria-hidden className="relative hidden h-8 text-emerald-300 sm:block">
      <ArrowUp className="absolute left-1/2 top-0 h-1.5 w-2.5 -translate-x-1/2" />
      <div className="absolute left-1/2 top-0 h-4 w-px -translate-x-1/2 bg-emerald-300" />
      <div
        className="absolute top-4 h-px bg-emerald-300"
        style={{
          left: "calc((100% - 3rem) / 8)",
          right: "calc((100% - 3rem) / 8)",
        }}
      />
      {[0, 1, 2, 3].map((i) => (
        <Fragment key={i}>
          <div
            className="absolute top-4 h-4 w-px bg-emerald-300"
            style={{ left: columnLeft(i) }}
          />
          <ArrowDown
            className="absolute bottom-0 h-1.5 w-2.5 -translate-x-1/2"
            style={{ left: columnLeft(i) }}
          />
        </Fragment>
      ))}
    </div>
  );
}

function AgentsToDataConnector() {
  const columnLeft = (i: number) =>
    `calc((100% - 3rem) / 8 + ${i} * ((100% - 3rem) / 4 + 1rem))`;
  return (
    <div aria-hidden className="relative hidden h-8 text-zinc-400 sm:block">
      {[1, 2].map((i) => (
        <Fragment key={i}>
          <div
            className="absolute top-0 h-full w-px bg-zinc-300"
            style={{ left: columnLeft(i) }}
          />
          <ArrowUp
            className="absolute top-0 h-1.5 w-2.5 -translate-x-1/2"
            style={{ left: columnLeft(i) }}
          />
        </Fragment>
      ))}
    </div>
  );
}

function ArrowUp({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 10 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="0,6 5,0 10,6" />
    </svg>
  );
}

function ArrowDown({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 10 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="0,0 5,6 10,0" />
    </svg>
  );
}

function ManagerCard() {
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center shadow-sm">
      <h3 className="text-[0.9375rem] font-semibold leading-snug text-zinc-900">
        Manager agent
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600">
        Pressure-tests the output at every step
      </p>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center shadow-sm">
      <h3 className="text-[0.9375rem] font-semibold leading-snug text-zinc-900">
        {agent.name}
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600">
        {agent.role}
      </p>
    </div>
  );
}

function DataCard() {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-sm">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        Data
      </p>
      <p className="mt-2 text-sm text-zinc-700">
        Sales <span className="text-zinc-300">·</span> Finance{" "}
        <span className="text-zinc-300">·</span> CX{" "}
        <span className="text-zinc-300">·</span> Marketing{" "}
        <span className="text-zinc-300">·</span> Product
      </p>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="4 10.5 8.5 15 16 6" />
    </svg>
  );
}
