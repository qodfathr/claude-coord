/** Whether the session's main loop is running a turn. */
export type CoordBusy = boolean

declare module 'claude-code' {
  interface PluginState {
    coord: { busy: CoordBusy }
  }
}
