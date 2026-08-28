// Real, locally-rendered example output from each Shorts Studio tool — not
// stock gameplay footage. Each clip was produced end-to-end by that tool's
// own render pipeline (see the tool's editor/export code) using a manually
// authored script/poll (no AI text generation involved) so it can showcase
// genuine output rather than a mock.
export type ShortsStudioSampleId =
  | "fake-text-story-01"
  | "fake-text-story-02"
  | "fake-text-story-03"
  | "would-you-rather-01"
  | "would-you-rather-02"
  | "would-you-rather-03"
  | "ai-clipper-01";

export type ShortsStudioSampleClip = {
  id: ShortsStudioSampleId;
  label: string;
  detail: string;
  src: string;
  poster: string;
};

export const SHORTS_STUDIO_SAMPLE_LIBRARY: ShortsStudioSampleClip[] = [
  {
    id: "fake-text-story-01",
    label: "Fake Text Story",
    detail: "Rendered iMessage story",
    src: "/media/shorts-studio-samples/fake-text-story-01.mp4",
    poster: "/media/shorts-studio-samples/fake-text-story-01.jpg",
  },
  {
    id: "fake-text-story-02",
    label: "Fake Text Story",
    detail: "Rendered iMessage story",
    src: "/media/shorts-studio-samples/fake-text-story-02.mp4",
    poster: "/media/shorts-studio-samples/fake-text-story-02.jpg",
  },
  {
    id: "fake-text-story-03",
    label: "Fake Text Story",
    detail: "Rendered iMessage story",
    src: "/media/shorts-studio-samples/fake-text-story-03.mp4",
    poster: "/media/shorts-studio-samples/fake-text-story-03.jpg",
  },
  {
    id: "would-you-rather-01",
    label: "Would You Rather",
    detail: "Rendered choice poll",
    src: "/media/shorts-studio-samples/would-you-rather-01.mp4",
    poster: "/media/shorts-studio-samples/would-you-rather-01.jpg",
  },
  {
    id: "would-you-rather-02",
    label: "Would You Rather",
    detail: "Rendered choice poll",
    src: "/media/shorts-studio-samples/would-you-rather-02.mp4",
    poster: "/media/shorts-studio-samples/would-you-rather-02.jpg",
  },
  {
    id: "would-you-rather-03",
    label: "Would You Rather",
    detail: "Rendered choice poll",
    src: "/media/shorts-studio-samples/would-you-rather-03.mp4",
    poster: "/media/shorts-studio-samples/would-you-rather-03.jpg",
  },
  {
    id: "ai-clipper-01",
    label: "AI Clipper",
    detail: "Real clip from a public video",
    src: "/media/shorts-studio-samples/ai-clipper-01.mp4",
    poster: "/media/shorts-studio-samples/ai-clipper-01.jpg",
  },
];

export function getShortsStudioSampleClip(id?: string) {
  return SHORTS_STUDIO_SAMPLE_LIBRARY.find((clip) => clip.id === id);
}
