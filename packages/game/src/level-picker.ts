export type LevelSetting = {
  label: string;
  description: string;
  checked: () => boolean;
  setChecked: (checked: boolean) => boolean;
};

/** Shows the current level's name, with buttons to step to the previous or next level. */
export class LevelPicker {
  readonly element = document.createElement("div");

  constructor(
    levels: { id: string; name: string }[],
    currentId: string,
    onSelect: (id: string) => void,
    settings: LevelSetting[],
  ) {
    this.element.id = "level-picker";
    const index = levels.findIndex((level) => level.id === currentId);

    const header = document.createElement("div");
    header.className = "level-picker-header";
    const title = document.createElement("div");
    title.className = "panel-title";
    title.textContent = `Level ${index + 1} of ${levels.length}`;
    header.appendChild(title);

    const menu = document.createElement("div");
    menu.className = "settings-menu";
    menu.hidden = true;
    for (const setting of settings) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = setting.checked();
      checkbox.addEventListener("change", () => {
        checkbox.checked = setting.setChecked(checkbox.checked);
      });
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = setting.label;
      const description = document.createElement("small");
      description.textContent = setting.description;
      text.append(name, description);
      label.append(checkbox, text);
      menu.appendChild(label);
    }

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "settings-button";
    settingsButton.textContent = "⚙";
    settingsButton.title = "Settings";
    settingsButton.setAttribute("aria-label", "Settings");
    settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      settingsButton.setAttribute("aria-expanded", String(!menu.hidden));
    });
    header.appendChild(settingsButton);

    const row = document.createElement("div");
    row.className = "level-picker-row";
    const step = (delta: number, label: string) => {
      const button = document.createElement("button");
      button.textContent = label;
      const target = levels[index + delta];
      button.disabled = !target;
      button.title = target ? target.name : "";
      button.addEventListener("click", () => onSelect(target.id));
      return button;
    };
    const name = document.createElement("div");
    name.className = "level-picker-name";
    name.textContent = levels[index].name;
    row.append(step(-1, "◀"), name, step(1, "▶"));

    this.element.append(header, row, menu);
  }
}
