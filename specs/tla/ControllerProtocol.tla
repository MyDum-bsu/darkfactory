---- MODULE ControllerProtocol ----
\* Компактная модель протокола контроллера v2 (Board + BB):
\* WAL intent -> receipt, сверка после прерывания во ВСЕХ трёх IN_FLIGHT фазах
\* (launching / returning / blocking), единственный живой писатель, seal перед
\* complete, watermark ходов BB, отсутствие слепого закрытия по кругам.
\* Парные мутанты (.cfg) снимают по одному гварду и обязаны краснеть с точным
\* именем нарушенного инварианта.

EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxEpoch,
    AllowTakeoverWithLiveWriter,    \* мутант 1: слот отдаётся при живом писателе
    AllowRetryOnEmptyObservation,   \* мутант 2: пустая выдача BB -> повторный LaunchSpawn
    SkipSealCheck,                  \* мутант 3: complete без сверки seal/эпохи
    AllowStaleTurnWatermark,        \* мутант 4: ход <= watermark считается новым ответом
    AllowTwoRoundsAutoClose         \* мутант 5: два круга -> complete без вердикта

VARIABLES
    boardState,          \* "ready" | "claimed" | "blocked" | "completed"
    boardEpoch,          \* серверная эпоха аренды: 0..MaxEpoch
    leaseAlive,          \* аренда текущей эпохи жива
    ctrlPhase,           \* "idle"|"claimed"|"launching"|"working"|"returning"|
                         \* "blocking"|"restarting"|"uncertain"|"hold"|"done"
    walIntent,           \* "none" | "spawn" | "feedback" | "block"
    walReceipt,          \* "none" | "spawn" | "feedback" | "block"
    worktreeReserved,    \* долговечная бронь worktree (slot.mjs)
    liveWriters,         \* множество РЕАЛЬНО живых писателей (эпохи)
    spawnOnWire,         \* spawn отправлен, но эффект ещё не наблюдаем/не зачислен
    feedbackOnWire,      \* feedback отправлен, но эффект ещё не наблюдаем
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
          worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire, spawnCount,
          candidateDigest, verifiedDigest, activePolicyDigest, pinnedPolicyDigest,
          lastTurnSeq, feedbackWatermark, acceptedTurnSeq, commitEpoch,
          reworkRounds, progressMade>>

ResetAttempt ==
    /\ walIntent' = "none" /\ walReceipt' = "none"
    /\ spawnOnWire' = FALSE /\ feedbackOnWire' = FALSE
    /\ candidateDigest' = "none" /\ verifiedDigest' = "none"
    /\ lastTurnSeq' = 0 /\ feedbackWatermark' = 0 /\ acceptedTurnSeq' = 0
    /\ reworkRounds' = 0 /\ progressMade' = FALSE

Init ==
    /\ boardState = "ready" /\ boardEpoch = 0 /\ leaseAlive = FALSE
    /\ ctrlPhase = "idle" /\ walIntent = "none" /\ walReceipt = "none"
    /\ worktreeReserved = FALSE /\ liveWriters = {}
    /\ spawnOnWire = FALSE /\ feedbackOnWire = FALSE
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
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* --- Spawn: intent -> send -> effect -> receipt -> reconcile -----------------

SpawnIntent ==
    /\ ctrlPhase = "claimed" /\ walIntent = "none"
    /\ walIntent' = "spawn" /\ ctrlPhase' = "launching"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Вызов bb.spawn. Мутант 2 может послать второй send, пока первый ещё на
\* проводе: guard ~spawnOnWire снимается AllowRetryOnEmptyObservation.
SpawnSend ==
    /\ ctrlPhase = "launching" /\ walIntent = "spawn"
    /\ \/ /\ ~spawnOnWire /\ spawnCount[boardEpoch] = 0
       \/ AllowRetryOnEmptyObservation    \* мутант 2: слепой повторный send
    /\ spawnOnWire' = TRUE
    /\ spawnCount' = [spawnCount EXCEPT ![boardEpoch] = @ + 1]
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, feedbackOnWire,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Эффект дошёл до внешнего мира: писатель реально жив (наблюдаемая сущность).
SpawnEffect ==
    /\ ctrlPhase = "launching" /\ spawnOnWire
    /\ liveWriters' = liveWriters \cup {boardEpoch}
    /\ spawnOnWire' = FALSE
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, feedbackOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Ack получен: receipt записан, переход в working.
SpawnReceipt ==
    /\ ctrlPhase = "launching" /\ walIntent = "spawn"
    /\ ~spawnOnWire /\ boardEpoch \in liveWriters
    /\ walReceipt' = "spawn" /\ walIntent' = "none" /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Обрыв процесса в любой IN_FLIGHT/рабочей фазе: запросы могут остаться на
\* проводе ненаблюдаемыми; WAL intent/receipt переживает крах.
Crash ==
    /\ ctrlPhase \in {"claimed", "launching", "working", "returning", "blocking"}
    /\ ctrlPhase' = "restarting"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Потерянный spawn при живой аренде: read-only сверка списка BB.
\* Совпадение ровно одного живого писателя -> adopt; пустая выдача НЕ доказывает
\* отсутствие эффекта -> карантин без повторного spawn. Мутант 2 возвращает
\* контроллер к запуску (LaunchSpawn -> второй SpawnSend).
ReconcileSpawn ==
    /\ ctrlPhase = "restarting" /\ walIntent = "spawn" /\ walReceipt = "none"
    /\ IF ~leaseAlive
        THEN /\ ctrlPhase' = "uncertain"    \* lease_lost: бронь сохраняется
             /\ UNCHANGED <<walIntent, walReceipt, liveWriters>>
        ELSE IF boardEpoch \in liveWriters /\ ~spawnOnWire
            THEN /\ walReceipt' = "spawn" /\ ctrlPhase' = "working"
                 /\ walIntent' = "none"
                 /\ UNCHANGED <<liveWriters>>
            ELSE IF AllowRetryOnEmptyObservation    \* мутант 2
                THEN /\ ctrlPhase' = "launching"    \* обратно к LaunchSpawn
                     /\ UNCHANGED <<walIntent, walReceipt, liveWriters>>
                ELSE /\ ctrlPhase' = "uncertain"
                     /\ UNCHANGED <<walIntent, walReceipt, liveWriters>>
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   spawnOnWire, feedbackOnWire, spawnCount, candidateDigest,
                   verifiedDigest, activePolicyDigest, pinnedPolicyDigest,
                   lastTurnSeq, feedbackWatermark, acceptedTurnSeq, commitEpoch,
                   reworkRounds, progressMade>>

\* --- Работа, ходы воркера, feedback и watermark -------------------------------

WorkerTurn ==
    /\ ctrlPhase = "working" /\ boardEpoch \in liveWriters /\ lastTurnSeq < 3
    /\ lastTurnSeq' = lastTurnSeq + 1
    /\ \/ /\ candidateDigest = "none" /\ candidateDigest' = "cand"
       \/ /\ UNCHANGED candidateDigest
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   feedbackOnWire, spawnCount, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, feedbackWatermark, acceptedTurnSeq,
                   commitEpoch, reworkRounds, progressMade>>

\* Возврат на доработку: durable intent feedback, фаза returning.
FeedbackIntent ==
    /\ ctrlPhase = "working" /\ walIntent = "none" /\ reworkRounds < 3
    /\ walIntent' = "feedback" /\ ctrlPhase' = "returning"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

FeedbackSend ==
    /\ ctrlPhase = "returning" /\ walIntent = "feedback" /\ ~feedbackOnWire
    /\ feedbackOnWire' = TRUE
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Внешний эффект: замечание доставлено — watermark сдвинулся в мире.
FeedbackDelivered ==
    /\ ctrlPhase = "returning" /\ feedbackOnWire
    /\ feedbackOnWire' = FALSE /\ feedbackWatermark' = lastTurnSeq
    /\ acceptedTurnSeq' = 0    \* израсходованный ответ не считается новым ходом
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, commitEpoch,
                   reworkRounds, progressMade>>

\* Ack получен: receipt, возврат в working; прежний ответ израсходован.
FeedbackReceipt ==
    /\ ctrlPhase = "returning" /\ walIntent = "feedback"
    /\ ~feedbackOnWire /\ feedbackWatermark = lastTurnSeq
    /\ walReceipt' = "feedback" /\ walIntent' = "none"
    /\ reworkRounds' = reworkRounds + 1 /\ acceptedTurnSeq' = 0
    /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   commitEpoch, progressMade>>

\* Потерянный ack feedback: read-only сверка журнала треда. Ровно одно
\* подтверждённое сообщение (watermark сдвинут эффектом) при живой аренде ->
\* adopt в working; 0/несколько/ошибка сверки -> uncertain без повторного tell.
ReconcileFeedback ==
    /\ ctrlPhase = "restarting" /\ walIntent = "feedback" /\ walReceipt = "none"
    /\ IF ~leaseAlive
        THEN /\ ctrlPhase' = "uncertain"
             /\ UNCHANGED <<walIntent, walReceipt, acceptedTurnSeq, reworkRounds>>
        ELSE IF ~feedbackOnWire /\ feedbackWatermark = lastTurnSeq /\ lastTurnSeq > 0
            THEN /\ walReceipt' = "feedback" /\ walIntent' = "none"
                 /\ reworkRounds' = reworkRounds + 1 /\ acceptedTurnSeq' = 0
                 /\ ctrlPhase' = "working"
            ELSE /\ ctrlPhase' = "uncertain"
                 /\ UNCHANGED <<walIntent, walReceipt, acceptedTurnSeq, reworkRounds>>
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   commitEpoch, progressMade>>

\* --- Блокировка: intent -> эффект на карточке -> receipt -> reconcile --------

\* Нарушение протокола хода/политики: durable intent block, фаза blocking.
BlockIntent ==
    /\ ctrlPhase = "working" /\ walIntent = "none"
    /\ walIntent' = "block" /\ ctrlPhase' = "blocking"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Внешний эффект: карточка реально переведена в blocked (board.block дошёл).
BlockDelivered ==
    /\ ctrlPhase = "blocking" /\ walIntent = "block" /\ boardState = "claimed"
    /\ boardState' = "blocked"
    /\ UNCHANGED <<boardEpoch, leaseAlive, ctrlPhase, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Ack получен: receipt, переход в hold.
BlockReceipt ==
    /\ ctrlPhase = "blocking" /\ walIntent = "block" /\ boardState = "blocked"
    /\ walReceipt' = "block" /\ walIntent' = "none" /\ ctrlPhase' = "hold"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Потерянный ack block: сверка по самой карточке. state = blocked с нашей
\* причиной -> adopt в hold; иначе uncertain. Повторный board.block не
\* отправляется никогда.
ReconcileBlock ==
    /\ ctrlPhase = "restarting" /\ walIntent = "block" /\ walReceipt = "none"
    /\ IF boardState = "blocked"
        THEN /\ walReceipt' = "block" /\ walIntent' = "none" /\ ctrlPhase' = "hold"
        ELSE /\ ctrlPhase' = "uncertain"
             /\ UNCHANGED <<walIntent, walReceipt>>
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackOnWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Ход засчитывается ответом на feedback только если он строго новее watermark.
AcceptTurn ==
    /\ ctrlPhase = "working"
    /\ \/ /\ lastTurnSeq > feedbackWatermark
          /\ acceptedTurnSeq' = lastTurnSeq
          /\ progressMade' = TRUE
       \/ /\ AllowStaleTurnWatermark        \* мутант 4: replay старого хода
          /\ feedbackWatermark > 0
          /\ lastTurnSeq > 0
          /\ lastTurnSeq <= feedbackWatermark
          /\ acceptedTurnSeq' = lastTurnSeq
          /\ UNCHANGED progressMade
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   feedbackOnWire, spawnCount, candidateDigest, verifiedDigest,
                   activePolicyDigest, pinnedPolicyDigest, lastTurnSeq,
                   feedbackWatermark, commitEpoch, reworkRounds>>

\* --- Проверка, seal и complete ------------------------------------------------

Verify ==
    /\ ctrlPhase = "working" /\ candidateDigest = "cand" /\ verifiedDigest = "none"
    /\ verifiedDigest' = "cand" /\ progressMade' = TRUE
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   feedbackOnWire, spawnCount, candidateDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds>>

ChangePolicy ==
    /\ boardState = "claimed" /\ activePolicyDigest = "p1" /\ activePolicyDigest' = "p2"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   feedbackOnWire, spawnCount, candidateDigest, verifiedDigest,
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
                   worktreeReserved, liveWriters, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, reworkRounds, progressMade>>

\* Старый писатель действительно умирает — только тогда слот может быть отдан.
WriterDies(e) ==
    /\ e \in liveWriters /\ liveWriters' = liveWriters \ {e}
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, spawnOnWire, feedbackOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

Next ==
    \/ Claim \/ Takeover \/ LeaseExpires
    \/ SpawnIntent \/ SpawnSend \/ SpawnEffect \/ SpawnReceipt
    \/ Crash \/ ReconcileSpawn \/ ReconcileFeedback \/ ReconcileBlock
    \/ WorkerTurn \/ FeedbackIntent \/ FeedbackSend \/ FeedbackDelivered \/ FeedbackReceipt
    \/ BlockIntent \/ BlockDelivered \/ BlockReceipt
    \/ AcceptTurn \/ Verify \/ ChangePolicy \/ Complete
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
