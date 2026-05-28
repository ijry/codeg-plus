"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react"
import {
  CheckCircle2,
  Hand,
  RotateCcw,
  SendHorizonal,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  PendingPermission,
  PendingQuestion,
} from "@/contexts/acp-connections-context"
import type { ConnectionStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import styles from "./office-simulation-workspace.module.css"

const WORKSTATION_IDS = ["A01", "A02", "A03", "A04"]
const TASK_POOL = [
  "整理需求清单",
  "生成初版实现计划",
  "补齐回归测试用例",
  "复核代码变更风险",
  "同步项目日报",
]

type WorkstationStatus = "idle" | "running" | "done"

interface WorkstationRuntime {
  id: string
  status: WorkstationStatus
  task: string | null
}

interface CameraState {
  panX: number
  panY: number
  zoom: number
  yaw: number
}

interface OfficeSimulationWorkspaceProps {
  status: ConnectionStatus | null
  queueSize: number
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  onRespondPermission: (requestId: string, optionId: string) => void
  onAnswerQuestion: (answer: string) => void
  messageList: ReactNode
}

const DEFAULT_CAMERA: CameraState = {
  panX: 0,
  panY: 0,
  zoom: 1,
  yaw: 0,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function shouldIgnoreSceneDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest("button,input,textarea,a,[data-sim-no-drag]"))
}

function buildCommandScreenText({
  status,
  queueSize,
  pendingPermission,
  pendingQuestion,
}: Pick<
  OfficeSimulationWorkspaceProps,
  "status" | "queueSize" | "pendingPermission" | "pendingQuestion"
>): {
  headline: string
  detail: string
  tone: "idle" | "busy" | "waiting"
} {
  const hasPendingPermission = Boolean(pendingPermission)
  const hasPendingQuestion = Boolean(pendingQuestion)

  if (hasPendingPermission || hasPendingQuestion) {
    const waitItems =
      Number(hasPendingPermission) + Number(hasPendingQuestion) + queueSize
    return {
      headline: "老板指挥大屏",
      detail: `有 ${waitItems} 项待你确认，员工已暂停等待指令`,
      tone: "waiting",
    }
  }

  if (status === "prompting") {
    return {
      headline: "老板指挥大屏",
      detail: `虚拟员工执行中，当前排队任务 ${queueSize} 项`,
      tone: "busy",
    }
  }

  return {
    headline: "老板指挥大屏",
    detail:
      queueSize > 0
        ? `待执行任务 ${queueSize} 项`
        : "办公室待命，可继续下发任务",
    tone: "idle",
  }
}

export function OfficeSimulationWorkspace({
  status,
  queueSize,
  pendingPermission,
  pendingQuestion,
  onRespondPermission,
  onAnswerQuestion,
  messageList,
}: OfficeSimulationWorkspaceProps) {
  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA)
  const [isDragging, setIsDragging] = useState(false)
  const [questionAnswer, setQuestionAnswer] = useState("")
  const [workstations, setWorkstations] = useState<WorkstationRuntime[]>(() =>
    WORKSTATION_IDS.map((id) => ({ id, status: "idle", task: null }))
  )
  const timerByStationRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )
  const previousQuestionIdRef = useRef<string | null>(null)
  const dragRef = useRef<{
    pointerId: number | null
    lastX: number
    lastY: number
  }>({
    pointerId: null,
    lastX: 0,
    lastY: 0,
  })
  const taskCursorRef = useRef(0)
  const questionId = pendingQuestion?.tool_call_id ?? null

  if (questionId !== previousQuestionIdRef.current) {
    previousQuestionIdRef.current = questionId
    if (questionId && questionAnswer !== "") {
      setQuestionAnswer("")
    }
  }

  useEffect(
    () => () => {
      for (const timer of timerByStationRef.current.values()) {
        clearTimeout(timer)
      }
      timerByStationRef.current.clear()
    },
    []
  )

  const sceneTransform = useMemo(
    () =>
      `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.zoom}) rotateZ(${camera.yaw}deg)`,
    [camera.panX, camera.panY, camera.zoom, camera.yaw]
  )

  const hasPendingPermission = Boolean(pendingPermission)
  const hasPendingQuestion = Boolean(pendingQuestion)
  const hasPendingActions = hasPendingPermission || hasPendingQuestion

  const board = buildCommandScreenText({
    status,
    queueSize,
    pendingPermission,
    pendingQuestion,
  })
  const activeTasks = useMemo(
    () =>
      workstations
        .filter((station) => station.status === "running" && station.task)
        .map((station) => `工位 ${station.id}：${station.task}`),
    [workstations]
  )

  const handleStagePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (shouldIgnoreSceneDragTarget(event.target)) return
      dragRef.current = {
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      setIsDragging(true)
    },
    []
  )

  const handleStagePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag.pointerId !== event.pointerId) return

      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY

      setCamera((prev) => ({
        panX: clamp(prev.panX + dx * 0.58, -56, 56),
        panY: clamp(prev.panY + dy * 0.58, -40, 40),
        zoom: prev.zoom,
        yaw: clamp(prev.yaw + dx * 0.06, -8, 8),
      }))
    },
    []
  )

  const handleStagePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag.pointerId !== event.pointerId) return
      drag.pointerId = null
      setIsDragging(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    []
  )

  const handleStageWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      setCamera((prev) => ({
        ...prev,
        zoom: clamp(prev.zoom + (event.deltaY < 0 ? 0.06 : -0.06), 0.85, 1.32),
      }))
    },
    []
  )

  const handleResetView = useCallback(() => {
    setCamera(DEFAULT_CAMERA)
  }, [])

  const handleAssignTask = useCallback(
    (stationId: string) => {
      if (hasPendingActions) return

      let assignedTask = ""
      setWorkstations((current) => {
        const target = current.find((station) => station.id === stationId)
        if (!target || target.status === "running") {
          return current
        }
        assignedTask = TASK_POOL[taskCursorRef.current % TASK_POOL.length]
        taskCursorRef.current += 1
        return current.map((station) =>
          station.id === stationId
            ? { ...station, status: "running", task: assignedTask }
            : station
        )
      })

      if (!assignedTask) return

      const existingTimer = timerByStationRef.current.get(stationId)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      const timer = setTimeout(
        () => {
          setWorkstations((current) =>
            current.map((station) =>
              station.id === stationId
                ? { ...station, status: "done", task: assignedTask }
                : station
            )
          )
        },
        2600 + Math.floor(Math.random() * 2200)
      )
      timerByStationRef.current.set(stationId, timer)
    },
    [hasPendingActions]
  )

  const handleSubmitQuestion = useCallback(() => {
    const answer = questionAnswer.trim()
    if (!answer) return
    onAnswerQuestion(answer)
    setQuestionAnswer("")
  }, [onAnswerQuestion, questionAnswer])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b border-border/80 bg-gradient-to-b from-muted/30 via-background to-background px-3 pb-3 pt-2 sm:px-4">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground sm:text-xs">
          <span>企业办公室仿真场景</span>
          <span>拖拽旋转 · 滚轮缩放 · 点击工位派任务</span>
        </div>
        <div
          className={cn(styles.stage, isDragging && styles.stageDragging)}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerEnd}
          onPointerCancel={handleStagePointerEnd}
          onWheel={handleStageWheel}
        >
          <div className={styles.scene} style={{ transform: sceneTransform }}>
            <div className={styles.floorGrid} />

            <div className={cn(styles.panel, styles.reception)}>
              <div className={styles.panelTitle}>前台</div>
              <div className={styles.panelSubtitle}>访客登记与任务分流</div>
            </div>

            <div className={cn(styles.panel, styles.bossZone)}>
              <div
                className={cn(
                  styles.commandBoard,
                  board.tone === "waiting" && styles.commandBoardWaiting,
                  board.tone === "busy" && styles.commandBoardBusy
                )}
              >
                <div className={styles.panelTitle}>{board.headline}</div>
                <div className={styles.panelSubtitle}>{board.detail}</div>

                {activeTasks.length > 0 && (
                  <ul className={styles.commandWaitList}>
                    {activeTasks.slice(0, 2).map((taskText) => (
                      <li key={taskText}>{taskText}</li>
                    ))}
                  </ul>
                )}

                {pendingPermission && (
                  <div className={styles.commandAction}>
                    <div className={styles.commandActionTitle}>
                      等待审批：工具调用请求
                    </div>
                    <div className={styles.commandActionButtons}>
                      {pendingPermission.options.map((option) => (
                        <Button
                          key={option.option_id}
                          size="sm"
                          variant={
                            option.kind.startsWith("reject")
                              ? "outline"
                              : "default"
                          }
                          onClick={() =>
                            onRespondPermission(
                              pendingPermission.request_id,
                              option.option_id
                            )
                          }
                        >
                          {option.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {pendingQuestion && (
                  <div className={styles.commandAction}>
                    <div className={styles.commandActionTitle}>
                      等待回复：{pendingQuestion.question}
                    </div>
                    <div className={styles.commandInputRow}>
                      <Input
                        value={questionAnswer}
                        onChange={(event) =>
                          setQuestionAnswer(event.target.value)
                        }
                        placeholder="在老板大屏输入回复..."
                      />
                      <Button
                        size="sm"
                        onClick={handleSubmitQuestion}
                        disabled={questionAnswer.trim().length === 0}
                      >
                        <SendHorizonal className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <div className={styles.bossDesk}>老板桌</div>
            </div>

            <div className={styles.workstations}>
              {workstations.map((station) => (
                <button
                  key={station.id}
                  type="button"
                  className={styles.workstation}
                  onClick={() => handleAssignTask(station.id)}
                  disabled={station.status === "running" || hasPendingActions}
                >
                  <div className={styles.workstationHead}>
                    <div className={styles.workstationLabel}>
                      工位 {station.id}
                    </div>
                    {station.status === "done" && (
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                    )}
                  </div>
                  <div
                    className={cn(
                      styles.monitor,
                      station.status === "running" && styles.monitorRunning,
                      station.status === "done" && styles.monitorDone
                    )}
                  >
                    <span className={styles.monitorDot} />
                    <span>
                      {hasPendingActions
                        ? "等待老板确认"
                        : station.status === "running"
                          ? (station.task ?? "执行中...")
                          : station.status === "done"
                            ? `${station.task ?? "任务"} 已完成`
                            : "点击派发任务"}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            <div className={cn(styles.employee, styles.employeeA)}>
              <span className={styles.employeeTag}>员工 1</span>
            </div>
            <div className={cn(styles.employee, styles.employeeB)}>
              <span className={styles.employeeTag}>员工 2</span>
            </div>
            <div className={cn(styles.chatBubble, styles.chatA)}>
              正在同步需求拆分
            </div>
            <div className={cn(styles.chatBubble, styles.chatB)}>
              任务进度已更新
            </div>
          </div>

          <div className={styles.viewHud} data-sim-no-drag="true">
            <span className={styles.viewChip}>
              <Hand className="size-3.5" />
              拖拽视角
            </span>
            <span className={styles.viewChip}>
              {camera.zoom >= 1 ? (
                <ZoomIn className="size-3.5" />
              ) : (
                <ZoomOut className="size-3.5" />
              )}
              缩放 {Math.round(camera.zoom * 100)}%
            </span>
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              onClick={handleResetView}
            >
              <RotateCcw className="size-3.5" />
              复位
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">{messageList}</div>
    </div>
  )
}
