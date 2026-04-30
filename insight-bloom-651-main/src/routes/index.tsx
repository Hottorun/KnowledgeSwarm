import { createFileRoute } from "@tanstack/react-router";
import { KnowledgeGraphCanvas } from "@/components/knowledge-graph/KnowledgeGraphCanvas";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "KnowledgeGraph — AI-Powered Company Data Visualization" },
      { name: "description", content: "Visualize and explore company data with an AI-powered interactive knowledge graph" },
    ],
  }),
});

function Index() {
  return <KnowledgeGraphCanvas />;
}
