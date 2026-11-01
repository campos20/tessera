/** Track colors, assigned in order and cycled. */
export const TRACK_COLORS = [
  "#ff9f0a",
  "#0a84ff",
  "#30d158",
  "#bf5af2",
  "#ff453a",
  "#64d2ff",
  "#ffd60a",
  "#ff375f",
  "#5e5ce6",
  "#ac8e68",
];

export const trackColor = (index: number) => TRACK_COLORS[index % TRACK_COLORS.length]!;
