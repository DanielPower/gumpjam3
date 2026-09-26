/** Shows the current level's name, with buttons to step to the previous or next level. */
export class LevelPicker {
  readonly element = document.createElement("div");

  constructor(levels: { id: string; name: string }[], currentId: string) {
    this.element.id = "level-picker";
    const index = levels.findIndex((level) => level.id === currentId);

    const title = document.createElement("div");
    title.className = "panel-title";
    title.textContent = `Level ${index + 1} of ${levels.length}`;

    const row = document.createElement("div");
    row.className = "level-picker-row";
    const step = (delta: number, label: string) => {
      const button = document.createElement("button");
      button.textContent = label;
      const target = levels[index + delta];
      button.disabled = !target;
      button.title = target ? target.name : "";
      button.addEventListener("click", () => {
        // A fresh page per level keeps setup simple; placements are per level anyway.
        const url = new URL(window.location.href);
        url.searchParams.set("level", target.id);
        window.location.href = url.toString();
      });
      return button;
    };
    const name = document.createElement("div");
    name.className = "level-picker-name";
    name.textContent = levels[index].name;
    row.append(step(-1, "◀"), name, step(1, "▶"));

    this.element.append(title, row);
  }
}
