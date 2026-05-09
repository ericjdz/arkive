import { useState, useEffect, useMemo, useCallback } from "react";
import { fetchArchitecture } from "../api/architecture.js";
import type { Architecture, Service, Decision, DataFlow } from "../api/architecture.js";

export interface SearchResults {
  services: Service[];
  decisions: Decision[];
  dataFlows: DataFlow[];
}

export interface UseArchitectureResult {
  data: Architecture | null;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: SearchResults;
  refresh: () => void;
}

export function useArchitecture(): UseArchitectureResult {
  const [data, setData] = useState<Architecture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const arch = await fetchArchitecture();
      setData(arch);
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const searchResults = useMemo((): SearchResults => {
    if (!data || !searchQuery.trim()) {
      return {
        services: data?.services ?? [],
        decisions: data?.decisions ?? [],
        dataFlows: data?.dataFlows ?? [],
      };
    }

    const q = searchQuery.toLowerCase();

    return {
      services: data.services.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.technology.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q)
      ),
      decisions: data.decisions.filter(
        (d) =>
          d.topic.toLowerCase().includes(q) ||
          d.decision.toLowerCase().includes(q) ||
          d.rationale.toLowerCase().includes(q)
      ),
      dataFlows: data.dataFlows.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.steps.some((s) => s.action.toLowerCase().includes(q))
      ),
    };
  }, [data, searchQuery]);

  return {
    data,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    searchResults,
    refresh: load,
  };
}
