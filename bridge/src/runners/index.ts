import type { Target } from "../protocol";
import { createCloudRunner } from "./cloud";
import { createLocalRunner } from "./local";
import type { Runner } from "./types";

export type Runners = Record<Target["kind"], Runner>;

export const createRunners = (): Runners => ({ local: createLocalRunner(), cloud: createCloudRunner() });
