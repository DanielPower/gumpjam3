/** Every TrenchBroom map in @stairs/shared/levels, as text, keyed by level id. See vite.config.ts. */
declare module "virtual:levels" {
  const levels: Record<string, string>;
  export default levels;
}
