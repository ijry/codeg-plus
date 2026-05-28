import type { ReactNode } from "react"
import type {
  ConnectionStatus,
  SessionModeInfo,
  SessionModeStateInfo,
} from "@/lib/types"
import type {
  PendingPermission,
  PendingQuestion,
} from "@/contexts/acp-connections-context"
import { OfficeSimulationWorkspace } from "@/features/simulation-mode/components/office-simulation-workspace"

export const SIMULATION_MODE_ID = "local_simulation_mode"

function resolveSimulationModeEnabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_ENABLE_SIMULATION_MODE
  if (!raw || raw.trim() === "") {
    return process.env.NODE_ENV !== "production"
  }
  const normalized = raw.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

export const SIMULATION_MODE_ENABLED = resolveSimulationModeEnabled()

export const SIMULATION_MODE: SessionModeInfo = {
  id: SIMULATION_MODE_ID,
  name: "仿真模式",
  description:
    "3D 企业办公室仿真：前台、老板桌、工位与大屏联动，像指挥虚拟员工一样完成任务。",
}

export function isSimulationMode(modeId: string | null | undefined): boolean {
  return SIMULATION_MODE_ENABLED && modeId === SIMULATION_MODE_ID
}

export function withSimulationMode(
  modes: SessionModeInfo[] | null | undefined
): SessionModeInfo[] {
  const base = modes ?? []
  if (!SIMULATION_MODE_ENABLED) {
    return base
  }
  if (base.some((mode) => mode.id === SIMULATION_MODE_ID)) {
    return base
  }
  return [...base, SIMULATION_MODE]
}

export function normalizeSimulationOutboundModeId(
  modeId: string | null | undefined
): string | null | undefined {
  if (isSimulationMode(modeId)) {
    return null
  }
  return modeId
}

export function shouldPersistAgentModePreference(
  modeId: string,
  modes: SessionModeStateInfo | null
): boolean {
  if (!modes) return false
  if (isSimulationMode(modeId)) return false
  return modes.available_modes.some((mode) => mode.id === modeId)
}

interface RenderSimulationMessagePanelOptions {
  selectedModeId: string | null
  status: ConnectionStatus | null
  queueSize: number
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  onRespondPermission: (requestId: string, optionId: string) => void
  onAnswerQuestion: (answer: string) => void
  messageList: ReactNode
}

export function renderSimulationMessagePanel({
  selectedModeId,
  status,
  queueSize,
  pendingPermission,
  pendingQuestion,
  onRespondPermission,
  onAnswerQuestion,
  messageList,
}: RenderSimulationMessagePanelOptions): ReactNode {
  if (!isSimulationMode(selectedModeId)) {
    return messageList
  }

  return (
    <OfficeSimulationWorkspace
      status={status}
      queueSize={queueSize}
      pendingPermission={pendingPermission}
      pendingQuestion={pendingQuestion}
      onRespondPermission={onRespondPermission}
      onAnswerQuestion={onAnswerQuestion}
      messageList={messageList}
    />
  )
}
