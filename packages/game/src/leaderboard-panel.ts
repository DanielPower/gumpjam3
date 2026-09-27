import { MAX_NAME_LENGTH, type LeaderboardEntry, type ReplayResponse } from "@stairs/shared/api";
import type { Placement } from "@stairs/shared/simulation";
import { fetchLeaderboard, fetchReplay, submitScore } from "./api";

const LEADERBOARD_SIZE = 10;
const NAME_STORAGE_KEY = "stairs.playerName";

/**
 * The level's top scores, each with a button to watch that run, and a form to
 * submit a finished run. Only the run's placements are sent; the server replays
 * them to work out the score.
 */
export class LeaderboardPanel {
  readonly element = document.createElement("div");
  private readonly list = document.createElement("ol");
  private readonly form = document.createElement("form");
  private readonly nameInput = document.createElement("input");
  private readonly submitButton = document.createElement("button");
  private readonly status = document.createElement("div");
  private readonly levelId: string;
  /** The finished run on offer for submission. */
  private pending: { placements: Placement[]; score: number } | null = null;
  private highlightId: number | null = null;
  private readonly onReplay: (replay: ReplayResponse) => void;

  /** `onReplay` is given a leaderboard entry's run when its play button is pressed. */
  constructor(levelId: string, onReplay: (replay: ReplayResponse) => void) {
    this.levelId = levelId;
    this.onReplay = onReplay;
    this.element.id = "leaderboard";

    const title = document.createElement("div");
    title.className = "panel-title";
    title.textContent = "Leaderboard";

    this.nameInput.placeholder = "Your name";
    this.nameInput.maxLength = MAX_NAME_LENGTH;
    this.nameInput.required = true;
    this.nameInput.value = localStorage.getItem(NAME_STORAGE_KEY) ?? "";
    this.nameInput.setAttribute("autocomplete", "nickname");
    this.submitButton.type = "submit";
    this.submitButton.textContent = "Submit";
    this.form.append(this.nameInput, this.submitButton);
    this.form.hidden = true;
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    this.status.className = "leaderboard-status";
    this.element.append(title, this.form, this.status, this.list);
    void this.refresh();
  }

  async refresh() {
    try {
      const { scores } = await fetchLeaderboard(this.levelId, LEADERBOARD_SIZE);
      this.renderList(scores);
    } catch (error) {
      this.list.replaceChildren(this.message(`${(error as Error).message}.`));
    }
  }

  /** Offer to submit a run that just finished. */
  offerSubmission(placements: readonly Placement[], score: number) {
    this.pending = { placements: structuredClone([...placements]), score };
    this.form.hidden = false;
    this.submitButton.disabled = false;
    // Not focused automatically: Space should still reset for another try.
    this.setStatus(`Submit your score of ${score.toLocaleString()}?`);
  }

  /** The run was reset before (or after) submitting it. */
  withdraw() {
    this.pending = null;
    this.form.hidden = true;
    this.setStatus("");
  }

  private async submit() {
    const pending = this.pending;
    const name = this.nameInput.value.trim();
    if (!pending || !name) return;
    localStorage.setItem(NAME_STORAGE_KEY, name);

    this.submitButton.disabled = true;
    this.setStatus("Submitting…");
    try {
      const result = await submitScore(this.levelId, {
        name,
        placements: pending.placements,
        claimedScore: pending.score,
      });
      if (this.pending !== pending) return;
      this.pending = null;
      this.form.hidden = true;
      this.highlightId = result.id;
      const scored =
        result.score === pending.score ? "" : ` (the server scored it ${result.score.toLocaleString()})`;
      this.setStatus(`Submitted! You're ranked #${result.rank}${scored}.`);
      await this.refresh();
    } catch (error) {
      if (this.pending !== pending) return;
      this.submitButton.disabled = false;
      this.setStatus((error as Error).message, true);
    }
  }

  private renderList(scores: LeaderboardEntry[]) {
    if (scores.length === 0) {
      this.list.replaceChildren(this.message("No scores yet. Be the first!"));
      return;
    }
    this.list.replaceChildren(
      ...scores.map((entry) => {
        const row = document.createElement("li");
        row.classList.toggle("mine", entry.id === this.highlightId);
        const rank = document.createElement("span");
        rank.textContent = `${entry.rank}.`;
        const name = document.createElement("span");
        name.textContent = entry.name;
        const score = document.createElement("span");
        score.textContent = entry.score.toLocaleString();
        const watch = document.createElement("button");
        watch.type = "button";
        watch.className = "watch";
        watch.textContent = "▶";
        watch.title = `Watch ${entry.name}'s run`;
        watch.setAttribute("aria-label", watch.title);
        watch.addEventListener("click", () => void this.watch(entry, watch));
        row.append(rank, name, score, watch);
        return row;
      }),
    );
  }

  /** Fetch an entry's run and hand it over to be replayed. */
  private async watch(entry: LeaderboardEntry, button: HTMLButtonElement) {
    button.disabled = true;
    try {
      this.onReplay(await fetchReplay(this.levelId, entry.id));
    } catch (error) {
      this.setStatus((error as Error).message, true);
    } finally {
      button.disabled = false;
      button.blur();
    }
  }

  private message(text: string) {
    const item = document.createElement("li");
    item.className = "leaderboard-message";
    item.textContent = text;
    return item;
  }

  private setStatus(text: string, isError = false) {
    this.status.textContent = text;
    this.status.classList.toggle("error", isError);
  }
}
