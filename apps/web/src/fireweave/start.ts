// The app's only FireWeave setup. Imported FIRST by the entry module.
import { start } from '@fireweaveai/web-sdk/start';
import { controlPoints } from './control-points';

export const ready = start({ controlPoints });
// Overrides (all optional). See .fireweave/agent-instructions.md, "FireWeave SDK: configuration and overrides (web)".
//   mode: 'local' | 'remote'          force a mode
//   environment: 'staging'            environment name for mode inference
//   url: '/fw'                        a same-origin proxy, or a self-hosted fw-server URL
//   persistence: 'memory'             store nothing until consent (then fw.setPersistence('localStorage'))
//   deviceId: analytics.anonymousId() reuse your analytics id as the anonymous key
