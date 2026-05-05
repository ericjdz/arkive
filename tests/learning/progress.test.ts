import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readProgress,
  writeProgress,
  recordAnswer,
  mergeNewConcepts,
  PROGRESS_DIR,
  PROGRESS_FILENAME,
} from "../../src/learning/progress.js";
import type { LearningProgress, ConceptMastery } from "../../src/learning/types.js";
import type { ExtractedConcept } from "../../src/learning/concepts.js";

describe("Learning Progress", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "archlearn-progress-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readProgress", () => {
    it("returns null when no progress file exists", () => {
      const result = readProgress(tmpDir);
      expect(result).toBeNull();
    });

    it("reads existing progress file", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [],
        totalQuestions: 0,
        correctAnswers: 0,
      };
      const dir = join(tmpDir, PROGRESS_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PROGRESS_FILENAME), JSON.stringify(progress));

      const result = readProgress(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.projectName).toBe("test-app");
    });
  });

  describe("writeProgress", () => {
    it("creates .archlearn directory and writes progress", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [],
        totalQuestions: 0,
        correctAnswers: 0,
      };
      writeProgress(tmpDir, progress);

      const filePath = join(tmpDir, PROGRESS_DIR, PROGRESS_FILENAME);
      expect(existsSync(filePath)).toBe(true);
      const written = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(written.projectName).toBe("test-app");
    });
  });

  describe("recordAnswer", () => {
    it("creates a new concept entry on first attempt", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [],
        totalQuestions: 0,
        correctAnswers: 0,
      };
      const updated = recordAnswer(progress, "concept-dec-001", "Database Choice", "decision", true);
      expect(updated.concepts).toHaveLength(1);
      expect(updated.concepts[0].mastered).toBe(true);
      expect(updated.concepts[0].attempts).toBe(1);
      expect(updated.totalQuestions).toBe(1);
      expect(updated.correctAnswers).toBe(1);
    });

    it("increments attempts on existing concept", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [
          {
            conceptId: "concept-dec-001",
            label: "Database Choice",
            category: "decision",
            mastered: false,
            attempts: 1,
            lastAttemptAt: "2026-05-05T11:00:00Z",
          },
        ],
        totalQuestions: 1,
        correctAnswers: 0,
      };
      const updated = recordAnswer(progress, "concept-dec-001", "Database Choice", "decision", true);
      expect(updated.concepts[0].attempts).toBe(2);
      expect(updated.concepts[0].mastered).toBe(true);
      expect(updated.totalQuestions).toBe(2);
      expect(updated.correctAnswers).toBe(1);
    });

    it("does not mark mastered on wrong answer", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [],
        totalQuestions: 0,
        correctAnswers: 0,
      };
      const updated = recordAnswer(progress, "concept-dec-001", "Database Choice", "decision", false);
      expect(updated.concepts[0].mastered).toBe(false);
      expect(updated.totalQuestions).toBe(1);
      expect(updated.correctAnswers).toBe(0);
    });
  });

  describe("mergeNewConcepts", () => {
    it("adds new concepts without losing existing mastery", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [
          {
            conceptId: "concept-dec-001",
            label: "Database Choice",
            category: "decision",
            mastered: true,
            attempts: 2,
            lastAttemptAt: "2026-05-05T11:00:00Z",
          },
        ],
        totalQuestions: 2,
        correctAnswers: 2,
      };
      const newConcepts: ExtractedConcept[] = [
        { id: "concept-dec-001", label: "Database Choice", category: "decision", sourceId: "dec-001" },
        { id: "concept-dec-002", label: "Real-time Strategy", category: "decision", sourceId: "dec-002" },
      ];
      const merged = mergeNewConcepts(progress, newConcepts);
      expect(merged.concepts).toHaveLength(2);
      expect(merged.concepts.find((c) => c.conceptId === "concept-dec-001")!.mastered).toBe(true);
      expect(merged.concepts.find((c) => c.conceptId === "concept-dec-002")!.mastered).toBe(false);
    });

    it("removes concepts no longer in architecture", () => {
      const progress: LearningProgress = {
        projectName: "test-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [
          {
            conceptId: "concept-dec-001",
            label: "Database Choice",
            category: "decision",
            mastered: true,
            attempts: 2,
            lastAttemptAt: "2026-05-05T11:00:00Z",
          },
          {
            conceptId: "concept-dec-removed",
            label: "Removed Decision",
            category: "decision",
            mastered: false,
            attempts: 1,
            lastAttemptAt: "2026-05-05T10:00:00Z",
          },
        ],
        totalQuestions: 3,
        correctAnswers: 2,
      };
      const newConcepts: ExtractedConcept[] = [
        { id: "concept-dec-001", label: "Database Choice", category: "decision", sourceId: "dec-001" },
      ];
      const merged = mergeNewConcepts(progress, newConcepts);
      expect(merged.concepts).toHaveLength(1);
      expect(merged.concepts[0].conceptId).toBe("concept-dec-001");
    });
  });
});
