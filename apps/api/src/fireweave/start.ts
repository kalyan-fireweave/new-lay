// The app's only FireWeave setup. Imported FIRST by the entrypoint.
import { start } from '@fireweaveai/server-sdk/start';
import { controlPoints } from './control-points';

start({ controlPoints });
// Overrides (all optional). See .fireweave/agent-instructions.md, "FireWeave SDK: configuration and overrides".
//   mode: 'local' | 'remote'          force a mode
//   environment: process.env.STAGE    your own environment variable for mode inference
//   url: 'https://flags.example.com'  self-hosted fw-server
//   key: secrets.fireweaveKey         key from your own secret store
