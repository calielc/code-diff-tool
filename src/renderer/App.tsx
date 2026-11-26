import { useCallback, useEffect, useState } from 'react'
import type { LaunchRequest } from '@shared/launch'
import type { ToolStatus } from '@shared/types'
import { api } from './api'
import { applyTheme } from './theme'
import { DevReader } from './features/DevReader'
import { Home } from './features/Home'
import { Prerequisites } from './features/Prerequisites'
import { ReviewView } from './features/ReviewView'

type Screen = { name: 'prereq' } | { name: 'home' } | { name: 'review'; slug: string }

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [status, setStatus] = useState<ToolStatus | null>(null)
  const [dev, setDev] = useState(false)

  useEffect(() => api.events.onOpenDev(() => setDev(true)), [])
  // Settings > Prerequisites… in the menu opens the Prerequisites screen from any screen.
  useEffect(
    () =>
      api.events.onOpenPrereq(() => {
        setDev(false)
        toPrereq()
      }),
    []
  )

  // The saved theme applies at once, and a choice in the Theme menu applies to the open page.
  useEffect(() => {
    void api.theme.get().then(applyTheme)
    return api.theme.onSet(applyTheme)
  }, [])

  // A request from outside the app (a second start, or a codediff:// link) opens the New review form, filled in.
  const [launch, setLaunch] = useState<LaunchRequest | null>(null)
  const takeLaunch = useCallback(() => {
    void api.launch.take().then((r) => {
      if (r) {
        setLaunch(r)
        setDev(false)
        setScreen((s) => (s && s.name === 'prereq' ? s : { name: 'home' }))
      }
    })
  }, [])
  useEffect(() => {
    takeLaunch()
    return api.launch.onNew(takeLaunch)
  }, [takeLaunch])

  // At every start the Prerequisites screen shows in place of Home when a required item is not ready (file 07 section 3.1).
  useEffect(() => {
    void api.app.checkTools().then((s) => {
      setStatus(s)
      setScreen(s.ready ? { name: 'home' } : { name: 'prereq' })
    })
  }, [])

  const toPrereq = (): void => {
    void api.app.checkTools().then(setStatus)
    setScreen({ name: 'prereq' })
  }

  if (dev) return <DevReader onClose={() => setDev(false)} />
  if (!screen) return <div className="page muted">Checking tools…</div>
  if (screen.name === 'review') {
    return <ReviewView slug={screen.slug} onHome={() => setScreen({ name: 'home' })} onOpenPrereq={toPrereq} />
  }
  // A missing git, a missing root, or no ready forge access stops the opening of reviews (file 07 section 3.4).
  const problem = status?.rows.find((r) => r.required && r.state !== 'ready')
  const forgeReady = status?.rows.some((r) => r.forge && r.state === 'ready')
  const blocked = problem ? problem.name : forgeReady === false ? 'GitLab or GitHub access' : null
  // The Prerequisites show as a dialog over Home, at the start when a requirement is missing and from the Settings menu.
  return (
    <>
      <Home
        blocked={blocked}
        paused={screen.name === 'prereq'}
        launch={launch}
        onLaunchUsed={() => setLaunch(null)}
        onOpenPrereq={toPrereq}
        onOpenReview={(slug) => setScreen({ name: 'review', slug })}
      />
      {screen.name === 'prereq' && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-label="Prerequisites">
          <div className="modal prereq">
            <Prerequisites atStart={true} onDone={() => setScreen({ name: 'home' })} onContinueAnyway={() => setScreen({ name: 'home' })} />
          </div>
        </div>
      )}
    </>
  )
}
