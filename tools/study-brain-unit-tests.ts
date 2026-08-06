/**
 * Study Brain unit checks — storage, URL classify, context mapping, persistence workflow.
 */
import assert from "node:assert/strict";
import {
  citationLabel,
  connectedSources,
  emptyBrain,
  emptySource,
  findSourceByCitation,
  hasDuplicateOrigin,
  positionAroundBrain,
  toAskContext,
} from "../src/lib/study-brain/storage.ts";
import { classifyUrl } from "../src/lib/study-brain/ingest.ts";

let passed = 0;

function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log("ok", name);
}

check("classify youtube", () => {
  assert.equal(classifyUrl("https://youtu.be/abc123"), "youtube");
  assert.equal(classifyUrl("https://www.youtube.com/watch?v=abc"), "youtube");
});

check("classify google docs family", () => {
  assert.equal(classifyUrl("https://docs.google.com/document/d/x/edit"), "gdoc");
  assert.equal(classifyUrl("https://docs.google.com/presentation/d/x/edit"), "gslides");
  assert.equal(classifyUrl("https://docs.google.com/spreadsheets/d/x/edit"), "gsheet");
  assert.equal(classifyUrl("https://drive.google.com/file/d/x/view"), "gdrive");
});

check("classify web", () => {
  assert.equal(classifyUrl("https://example.com/notes"), "web");
});

check("connected sources + ask context", () => {
  const brain = emptyBrain("Biology Exam");
  const a = emptySource({
    id: "s1",
    kind: "text",
    title: "Biology Notes.pdf",
    origin: "Biology Notes.pdf",
    body: "Mitosis is cell division.",
    locator: "page 12",
    status: "ready",
    connected: true,
  });
  const b = emptySource({
    id: "s2",
    kind: "youtube",
    title: "Lecture",
    origin: "https://youtu.be/x",
    body: "Meiosis creates gametes.",
    status: "ready",
    connected: false,
    locator: "14:32",
  });
  brain.sources = [a, b];
  brain.connections = ["s1"];
  const linked = connectedSources(brain);
  assert.equal(linked.length, 1);
  assert.equal(linked[0]!.id, "s1");
  const ctx = toAskContext(linked);
  assert.equal(ctx[0]!.title, "Biology Notes.pdf");
  assert.equal(ctx[0]!.source, "Biology Notes.pdf — page 12");
  assert.ok(ctx[0]!.body.includes("Mitosis"));
});

check("brain defaults", () => {
  const brain = emptyBrain("Biology Exam");
  assert.equal(brain.title, "Biology Exam");
  assert.ok(brain.positions.brain);
  assert.deepEqual(brain.materials, { quiz: null, flashcards: null, guide: null });
});

check("radial placement + duplicates + citations", () => {
  const brain = emptyBrain("Biology Exam");
  const pos = positionAroundBrain(brain.positions.brain!, 0);
  assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
  const pdf = emptySource({
    id: "pdf1",
    kind: "pdf",
    title: "Biology Notes.pdf",
    origin: "Biology Notes.pdf",
    body: "Cell division overview.",
    locator: "page 12",
    status: "ready",
    connected: true,
  });
  const yt = emptySource({
    id: "yt1",
    kind: "youtube",
    title: "Lecture Video",
    origin: "https://youtu.be/demo",
    body: "Mitosis stages.",
    locator: "14:32",
    status: "ready",
    connected: true,
  });
  const doc = emptySource({
    id: "doc1",
    kind: "gdoc",
    title: "Class Notes",
    origin: "https://docs.google.com/document/d/owned/edit",
    body: "Owned notes body.",
    status: "ready",
    connected: true,
  });
  const slides = emptySource({
    id: "slides1",
    kind: "gslides",
    title: "Cell Division Slides",
    origin: "https://docs.google.com/presentation/d/owned/edit",
    body: "Slide deck text.",
    locator: "slide 8",
    status: "ready",
    connected: true,
  });
  const sheet = emptySource({
    id: "sheet1",
    kind: "gsheet",
    title: "Experiment Data",
    origin: "https://docs.google.com/spreadsheets/d/owned/edit",
    body: "Results table.",
    locator: "Results!B4:F18",
    status: "ready",
    connected: true,
  });
  brain.sources = [pdf, yt, doc, slides, sheet];
  brain.connections = brain.sources.map((s) => s.id);
  assert.equal(connectedSources(brain).length, 5);
  assert.equal(hasDuplicateOrigin(brain, "Biology Notes.pdf"), true);
  assert.equal(hasDuplicateOrigin(brain, "Other.pdf"), false);
  assert.equal(findSourceByCitation(brain, citationLabel(slides))?.id, "slides1");
  assert.equal(findSourceByCitation(brain, "Experiment Data — Results!B4:F18")?.id, "sheet1");
  assert.equal(findSourceByCitation(brain, "Lecture Video — 14:32")?.id, "yt1");
});

check("biology exam persistence workflow", () => {
  const brain = emptyBrain("Biology Exam");
  const sources = [
    emptySource({
      id: "pdf1",
      kind: "pdf",
      title: "Biology Notes.pdf",
      origin: "Biology Notes.pdf",
      body: "Mitosis.",
      locator: "page 12",
      status: "ready",
      connected: true,
    }),
    emptySource({
      id: "yt1",
      kind: "youtube",
      title: "Lecture Video",
      origin: "https://youtu.be/demo",
      body: "Meiosis.",
      locator: "14:32",
      status: "ready",
      connected: true,
    }),
  ];
  brain.sources = sources;
  brain.connections = sources.map((s) => s.id);
  brain.messages = [
    { id: "m1", role: "user", content: "What is mitosis?", at: 1 },
    {
      id: "m2",
      role: "assistant",
      content: "Mitosis is cell division. [S1]",
      citations: [citationLabel(sources[0]!)],
      at: 2,
    },
  ];
  brain.materials = {
    quiz: {
      topic: "Biology Exam",
      questions: [
        {
          id: "q1",
          question: "What is mitosis?",
          options: ["A", "B", "C", "D"],
          correct: 1,
          hint: "",
          explanation: "",
        },
      ],
    },
    flashcards: {
      topic: "Biology Exam",
      cards: [{ id: "c1", front: "Mitosis", back: "Cell division", tag: "cells", confidence: 3, dueAt: Date.now() }],
    },
    guide: {
      title: "Biology guide",
      sections: [{ heading: "Cells", cue: "Recall", points: ["Mitosis"] }],
      summary: "Cell division overview",
      questions: [{ q: "Define mitosis", a: "Cell division" }],
    },
  };
  const serialized = JSON.stringify({ version: 4, brains: [brain], activeBrainId: brain.id });
  const restored = JSON.parse(serialized);
  assert.equal(restored.brains[0].title, "Biology Exam");
  assert.equal(restored.brains[0].sources.length, 2);
  assert.equal(restored.brains[0].connections.length, 2);
  assert.equal(restored.brains[0].materials.quiz.questions.length, 1);
  assert.equal(restored.brains[0].materials.flashcards.cards.length, 1);
  assert.equal(restored.brains[0].materials.guide.title, "Biology guide");
  assert.equal(restored.brains[0].messages[1].citations[0], "Biology Notes.pdf — page 12");
});

console.log(`study-brain-unit-tests: ${passed} assertions passed`);
