export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\.(com|io|so|ai|app|dev|co|net|org)(\/.*)?$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
