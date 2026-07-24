export type FakeTextGameplayCategory = "subway" | "minecraft" | "gta";

export type FakeTextGameplayClip = {
  id: string;
  category: FakeTextGameplayCategory;
  label: string;
  timeRange: string;
  src: string;
  poster: string;
  durationSeconds: 40;
  sourceUrl: string;
};

const sourceUrls: Record<FakeTextGameplayCategory, string> = {
  subway: "https://youtu.be/QPW3XwBoQlw",
  minecraft: "https://youtu.be/u7kdVe8q5zs",
  gta: "https://youtu.be/ZtLrNBdXT7M",
};

const ranges: Record<FakeTextGameplayCategory, string[]> = {
  subway: ["0:00-0:40", "0:40-1:20", "1:20-2:00", "2:00-2:40", "2:33-3:13"],
  minecraft: ["2:00-2:40", "7:30-8:10", "13:00-13:40", "18:30-19:10", "24:00-24:40"],
  gta: ["0:20-1:00", "2:40-3:20", "5:00-5:40", "7:20-8:00", "9:40-10:20"],
};

const labels: Record<FakeTextGameplayCategory, string> = {
  subway: "Subway Surfers",
  minecraft: "Minecraft",
  gta: "GTA",
};

export const FAKE_TEXT_GAMEPLAY_LIBRARY: FakeTextGameplayClip[] = (
  Object.keys(ranges) as FakeTextGameplayCategory[]
).flatMap((category) => ranges[category].map((timeRange, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    id: `${category}-${number}`,
    category,
    label: `${labels[category]} ${index + 1}`,
    timeRange,
    src: `/media/fake-text/gameplay/${category}/${category}-${number}.mp4`,
    poster: `/media/fake-text/gameplay/${category}/${category}-${number}.jpg`,
    durationSeconds: 40 as const,
    sourceUrl: sourceUrls[category],
  };
}));

export function getFakeTextGameplayClip(id?: string) {
  return FAKE_TEXT_GAMEPLAY_LIBRARY.find((clip) => clip.id === id) || FAKE_TEXT_GAMEPLAY_LIBRARY[0];
}
