export function App() {
  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h1>Architecture Viewer</h1>
      <p>Loading...</p>
    </div>
  );
}
import { useState } from "react";
import { useArchitecture } from "./hooks/useArchitecture.js";
import { ViewSwitcher } from "./components/ViewSwitcher.js";
import type { ViewId } from "./components/ViewSwitcher.js";
import { SearchBar } from "./components/SearchBar.js";
import { TopologyView } from "./views/TopologyView.js";
import { DataFlowView } from "./views/DataFlowView.js";
import { DecisionLogView } from "./views/DecisionLogView.js";
import { TreeView } from "./views/TreeView.js";
import { StackView } from "./views/StackView.js";

export function App() {
  const {
    data,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    searchResults,
    refresh,
  } = useArchitecture();
  const [activeView, setActiveView] = useState<ViewId>("topology");

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--color-text-muted)",
        }}
      >
        Loading architecture...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: "1rem",
          color: "var(--color-error)",
        }}
      >
        <div>Failed to load architecture data</div>
        <div style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>
          {error}
        </div>
        <button
          onClick={refresh}
          style={{
            padding: "0.5rem 1rem",
            background: "var(--color-accent)",
            color: "#fff",
            border: "none",
            borderRadius: "var(--radius)",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-bg)",
          flexShrink: 0,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "0.9375rem", flexShrink: 0 }}>
          {data.project.name}
        </div>
        <ViewSwitcher activeView={activeView} onViewChange={setActiveView} />
        <div style={{ marginLeft: "auto", width: 280 }}>
          <SearchBar value={searchQuery} onChange={setSearchQuery} />
        </div>
      </header>

      {/* View content */}
      <main style={{ flex: 1, overflow: "hidden" }}>
        {activeView === "topology" && (
          <TopologyView
            services={searchResults.services}
            connections={data.connections}
            decisions={data.decisions}
          />
        )}
        {activeView === "dataflow" && (
          <DataFlowView
            dataFlows={searchResults.dataFlows}
            services={data.services}
          />
        )}
        {activeView === "decisions" && (
          <DecisionLogView decisions={searchResults.decisions} />
        )}
        {activeView === "tree" && (
          <TreeView services={searchResults.services} />
        )}
        {activeView === "stack" && (
          <StackView stack={data.stack} decisions={data.decisions} />
        )}
      </main>
    </div>
  );
}
