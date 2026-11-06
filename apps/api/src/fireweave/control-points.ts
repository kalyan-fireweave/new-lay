// Every control point this app reads, with its LOCAL value.
// Production values come from FireWeave rollouts, never from this file.
import { defineControlPoints } from '@fireweaveai/server-sdk/start';

export const controlPoints = defineControlPoints({
  // 'new-checkout': { local: true },
});
