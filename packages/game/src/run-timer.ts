import { TIME_STEP } from "@stairs/shared/simulation";
import type { Run } from "@stairs/shared/run";

/**
 * A bar showing how long the run has left. It drains while the ragdoll isn't
 * taking damage and refills, with a flash, whenever a hit resets the timer.
 */
export class RunTimer {
  readonly element = document.createElement("div");
  private readonly label = document.createElement("div");
  private readonly fill = document.createElement("div");
  private lastFraction = 1;

  constructor() {
    this.element.id = "run-timer";
    this.label.className = "run-timer-label";
    const track = document.createElement("div");
    track.className = "run-timer-track";
    this.fill.className = "run-timer-fill";
    track.appendChild(this.fill);
    this.element.append(this.label, track);
    this.element.hidden = true;
  }

  /** Show the run's remaining time, or hide the bar when no run is in progress. */
  update(run: Run | null) {
    this.element.hidden = run === null;
    if (!run) return;

    // Out of the quiet window; the 60 s cap shows up as the bar running out early.
    const fraction = Math.min(1, run.stepsRemaining / run.limits.quietSteps);
    if (fraction > this.lastFraction + 1e-6 && run.stepsTaken > 1) {
      this.fill.classList.remove("refill");
      void this.fill.offsetWidth; // restart the animation
      this.fill.classList.add("refill");
    }
    this.lastFraction = fraction;

    this.fill.style.width = `${fraction * 100}%`;
    this.fill.style.backgroundColor = `hsl(${Math.round(120 * fraction)}, 80%, 50%)`;
    this.label.textContent = run.finished
      ? "Run over"
      : `Ends in ${(run.stepsRemaining * TIME_STEP).toFixed(1)}s`;
  }
}
