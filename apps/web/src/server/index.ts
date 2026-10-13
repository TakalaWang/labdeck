// Registers every route (side-effect imports) and exposes the dispatcher.
import './routes-auth.ts'
import './routes-hosts.ts'
import './routes-metrics.ts'
import './routes-me.ts'
import './routes-admin.ts'
import './routes-content.ts'

export { handle, testHooks, csrfOk } from './app.ts'
