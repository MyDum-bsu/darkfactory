---- MODULE ControllerProtocol ----
\* Компактная модель протокола контроллера v2 (Board + BB):
\* WAL intent -> receipt, сверка после прерывания, единственный живой писатель,
\* seal перед complete, watermark ходов BB, отсутствие слепого закрытия по кругам.
\* Парные мутанты (.cfg) снимают по одному гварду и обязаны краснеть с точным
\* именем нарушенного инварианта.

EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxEpoch,
    AllowTakeoverWithLiveWriter,    \* мутант 1: слот отдаётся при живом писателе
    AllowRetryOnEmptyObservation,   \* мутант 2: пустая выдача BB -> второй spawn
    SkipSealCheck,                  \* мутант 3: complete без сверки seal/эпохи
    AllowStaleTurnWatermark,        \* мутант 4: старый ход считается новым ответом
    AllowTwoRoundsAutoClose         \* мутант 5: два круга -> complete без вердикта

VARIABLES
    boardState,          \* "ready" | "claimed" | "blocked" | "completed"
    boardEpoch,          \* серверная эпоха аренды: 0..MaxEpoch
    leaseAlive,          \* аренда текущей эпохи жива
    ctrlPhase,           \* "idle"|"claimed"|"launching"|"working"|"restarting"|"uncertain"|"done"
    walIntent,           \* "none" | "spawn" | "feedback" | "block"
    walReceipt,          \* "none" | "spawn" | "feedback" | "block"
    worktreeReserved,    \* долговечная бронь worktree (slot.mjs)
    liveWriters,         \* множество РЕАЛЬНО живых писателей (эпохи)
    spawnOnWire,         \* spawn отправлен, но эффект ещё не наблюдаем
    spawnCount,          \* [1..MaxEpoch -> 0..2] — число вызовов spawn на эпоху
    candidateDigest,     \* "none" | "cand"
    verifiedDigest,      \* "none" | "cand"
    activePolicyDigest,  \* "p1" | "p2" — действующая политика на Board
    pinnedPolicyDigest,  \* закреплённая при claim политика
    lastTurnSeq,         \* последний произведённый воркером ход: 0..3
    feedbackWatermark,   \* seq последнего доставленного feedback
    acceptedTurnSeq,     \* ход, засчитанный ответом на feedback (0 — ещё нет)
    commitEpoch,         \* эпоха, под которой карточка закрыта
    reworkRounds,        \* число раундов доработки: 0..3
    progressMade         \* был ли зарегистрирован реальный прогресс

vars == <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent, walReceipt,
          worktreeReserved, liveWriters, spawnOnWire, spawnCount, candidateDigest,
          verifiedDigest, activePolicyDigest, pinnedPolicyDigest, lastTurnSeq,
          feedbackWatermark, acceptedTurnSeq, commitEpoch, reworkRounds,
          progressMade>>

ResetAttempt ==
    /\ walIntent' = "none" /\ walReceipt' = "none" /\ spawnOnWire' = FALSE
    /\ candidateDigest' = "none" /\ verifiedDigest' = "none"
    /\ lastTurnSeq' = 0 /\ feedbackWatermark' = 0 /\ acceptedTurnSeq' = 0
    /\ reworkRounds' = 0 /\ progressMade' = FALSE

Init ==
    /\ boardState = "ready" /\ boardEpoch = 0 /\ leaseAlive = FALSE
    /\ ctrlPhase = "idle" /\ walIntent = "none" /\ walReceipt = "none"
    /\ worktreeReserved = FALSE /\ liveWriters = {} /\ spawnOnWire = FALSE
    /\ spawnCount = [e \in 1..MaxEpoch |-> 0]
    /\ candidateDigest = "none" /\ verifiedDigest = "none"
    /\ activePolicyDigest = "p1" /\ pinnedPolicyDigest = "p1"
    /\ lastTurnSeq = 0 /\ feedbackWatermark = 0 /\ acceptedTurnSeq = 0
    /\ commitEpoch = 0 /\ reworkRounds = 0 /\ progressMade = FALSE

\* --- Захват и аренда --------------------------------------------------------

Claim ==
    /\ boardState = "ready" /\ boardEpoch < MaxEpoch /\ ctrlPhase = "idle"
    /\ boardEpoch' = boardEpoch + 1 /\ boardState' = "claimed"
    /\ leaseAlive' = TRUE /\ ctrlPhase' = "claimed"
    /\ pinnedPolicyDigest' = activePolicyDigest /\ worktreeReserved' = TRUE
    /\ ResetAttempt
    /\ UNCHANGED <<liveWriters, spawnCount, activePolicyDigest, commitEpoch>>

\* Истёкшая аренда: новый claim той же карточки под следующей эпохой.
\* База: слот worktree отдаётся только когда живых писателей нет.
Takeover ==
    /\ boardState = "claimed" /\ ~leaseAlive /\ boardEpoch < MaxEpoch
    /\ \/ liveWriters = {}
       \/ AllowTakeoverWithLiveWriter     \* мутант 1: зомби-писатель жив
    /\ boardEpoch' = boardEpoch + 1 /\ leaseAlive' = TRUE
    /\ ctrlPhase' = "claimed" /\ pinnedPolicyDigest' = activePolicyDigest
    /\ ResetAttempt
    /\ UNCHANGED <<boardState, worktreeReserved, liveWriters, spawnCount,
                   activePolicyDigest, commitEpoch>>

LeaseExpires ==
    /\ leaseAlive /\ leaseAlive' = FALSE
    /\ UNCHANGED <<boardState, boardEpoch, ctrlPhase, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* --- Spawn: intent -> send -> land/crash -> reconcile ------------------------

SpawnIntent ==
    /\ ctrlPhase = "claimed" /\ walIntent = "none"
    /\ walIntent' = "spawn" /\ ctrlPhase' = "launching"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

SpawnSend ==
    /\ ctrlPhase = "launching" /\ walIntent = "spawn" /\ ~spawnOnWire
    /\ spawnOnWire' = TRUE
    /\ spawnCount' = [spawnCount EXCEPT ![boardEpoch] = @ + 1]
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, candidateDigest,
                   verifiedDigest, activePolicyDigest, pinnedPolicyDigest,
                   lastTurnSeq, feedbackWatermark, acceptedTurnSeq, commitEpoch,
                   reworkRounds, progressMade>>

\* Эффект дошёл: писатель реально жив, ack получен, receipt записан.
SpawnLands ==
    /\ ctrlPhase = "launching" /\ spawnOnWire
    /\ liveWriters' = liveWriters \cup {boardEpoch}
    /\ spawnOnWire' = FALSE /\ walIntent' = "none" /\ walReceipt' = "spawn"
    /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive,
                   worktreeReserved, spawnCount, candidateDigest, verifiedDigest,
                   activePolicyDigest, pinnedPolicyDigest, lastTurnSeq,
                   feedbackWatermark, acceptedTurnSeq, commitEpoch, reworkRounds,
                   progressMade>>

\* Обрыв процесса: запрос может остаться "на проводе" ненаблюдаемым.
Crash ==
    /\ ctrlPhase \in {"claimed", "launching", "working"}
    /\ ctrlPhase' = "restarting"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Потерянный spawn при живой аренде: read-only сверка списка BB.
\* Совпадение ровно одного живого писателя -> adopt; пустая выдача НЕ доказывает
\* отсутствие эффекта (запрос ещё на проводе) -> карантин без повторного spawn.
ReconcileSpawn ==
    /\ ctrlPhase = "restarting" /\ walIntent = "spawn" /\ walReceipt = "none"
    /\ IF ~leaseAlive
        THEN /\ ctrlPhase' = "uncertain"    \* lease_lost: бронь сохраняется
             /\ UNCHANGED <<walIntent, walReceipt, spawnOnWire, spawnCount,
                            liveWriters>>
        ELSE IF boardEpoch \in liveWriters
            THEN /\ walReceipt' = "spawn" /\ ctrlPhase' = "working"
                 /\ walIntent' = "none" /\ spawnOnWire' = FALSE
                 /\ UNCHANGED <<spawnCount, liveWriters>>
            ELSE IF AllowRetryOnEmptyObservation    \* мутант 2
                THEN /\ spawnOnWire' = TRUE
                     /\ spawnCount' = [spawnCount EXCEPT ![boardEpoch] = @ + 1]
                     /\ ctrlPhase' = "launching"
                     /\ UNCHANGED <<walIntent, walReceipt, liveWriters>>
                ELSE /\ ctrlPhase' = "uncertain"
                     /\ UNCHANGED <<walIntent, walReceipt, spawnOnWire,
                                    spawnCount, liveWriters>>
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* --- Работа, feedback и watermark --------------------------------------------

WorkerTurn ==
    /\ ctrlPhase = "working" /\ boardEpoch \in liveWriters /\ lastTurnSeq < 3
    /\ lastTurnSeq' = lastTurnSeq + 1
    /\ \/ /\ candidateDigest = "none" /\ candidateDigest' = "cand"
       \/ /\ UNCHANGED candidateDigest
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, feedbackWatermark, acceptedTurnSeq,
                   commitEpoch, reworkRounds, progressMade>>

\* Раунд доработки: intent feedback, доставка двигает watermark.
Rework ==
    /\ ctrlPhase = "working" /\ walIntent = "none" /\ reworkRounds < 3
    /\ walIntent' = "feedback"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

FeedbackLands ==
    /\ ctrlPhase = "working" /\ walIntent = "feedback"
    /\ feedbackWatermark' = lastTurnSeq
    /\ walReceipt' = "feedback" /\ walIntent' = "none"
    /\ reworkRounds' = reworkRounds + 1
    /\ acceptedTurnSeq' = 0    \* прежний ответ израсходован новым feedback
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase,
                   worktreeReserved, liveWriters, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, commitEpoch,
                   progressMade>>

\* Ход засчитывается ответом на feedback только если он строго новее watermark.
AcceptTurn ==
    /\ ctrlPhase = "working"
    /\ \/ /\ lastTurnSeq > feedbackWatermark
          /\ acceptedTurnSeq' = lastTurnSeq
          /\ progressMade' = TRUE
       \/ /\ AllowStaleTurnWatermark        \* мутант 4
          /\ feedbackWatermark > 0
          /\ acceptedTurnSeq' = feedbackWatermark
          /\ UNCHANGED progressMade
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest,
                   activePolicyDigest, pinnedPolicyDigest, lastTurnSeq,
                   feedbackWatermark, commitEpoch, reworkRounds>>

\* --- Проверка, seal и complete ------------------------------------------------

Verify ==
    /\ ctrlPhase = "working" /\ candidateDigest = "cand" /\ verifiedDigest = "none"
    /\ verifiedDigest' = "cand" /\ progressMade' = TRUE
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds>>

ChangePolicy ==
    /\ boardState = "claimed" /\ activePolicyDigest = "p1" /\ activePolicyDigest' = "p2"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

Complete ==
    /\ ctrlPhase = "working" /\ boardState = "claimed"
    /\ \/ /\ AllowTwoRoundsAutoClose        \* мутант 5: слепое закрытие по счётчику
          /\ reworkRounds >= 2
          /\ candidateDigest = "none"       \* без верифицированного кандидата
          /\ pinnedPolicyDigest = activePolicyDigest
       \/ /\ ~AllowTwoRoundsAutoClose
          /\ candidateDigest # "none" /\ verifiedDigest = candidateDigest
          /\ \/ SkipSealCheck               \* мутант 3: пропуск сверки seal
             \/ pinnedPolicyDigest = activePolicyDigest
    /\ boardState' = "completed" /\ commitEpoch' = boardEpoch
    /\ ctrlPhase' = "done"
    /\ UNCHANGED <<boardEpoch, leaseAlive, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, reworkRounds, progressMade>>

\* Старый писатель действительно умирает — только тогда слот может быть отдан.
WriterDies(e) ==
    /\ e \in liveWriters /\ liveWriters' = liveWriters \ {e}
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, spawnOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

Next ==
    \/ Claim \/ Takeover \/ LeaseExpires
    \/ SpawnIntent \/ SpawnSend \/ SpawnLands \/ Crash \/ ReconcileSpawn
    \/ WorkerTurn \/ Rework \/ FeedbackLands \/ AcceptTurn
    \/ Verify \/ ChangePolicy \/ Complete
    \/ \E e \in 1..MaxEpoch : WriterDies(e)

Spec == Init /\ [][Next]_vars

\* --- Safety-инварианты --------------------------------------------------------

SingleLiveWriter ==
    Cardinality(liveWriters) <= 1

NoDuplicateSpawn ==
    \A e \in 1..MaxEpoch : spawnCount[e] <= 1

NoStaleCommit ==
    boardState = "completed" =>
        (commitEpoch = boardEpoch /\ verifiedDigest = candidateDigest
         /\ pinnedPolicyDigest = activePolicyDigest)

NoWatermarkRegression ==
    acceptedTurnSeq = 0 \/ acceptedTurnSeq > feedbackWatermark

NoBlindRoundClose ==
    boardState = "completed" =>
        (verifiedDigest # "none" /\ verifiedDigest = candidateDigest)

================================================================================
