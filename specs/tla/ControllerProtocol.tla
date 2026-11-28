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
    ctrlPhase,           \* "idle"|"claimed"|"launching"|"launching_retry"|"working"|
                         \* "checking"|"returning"|"blocking"|"restarting"|
                         \* "uncertain"|"hold"|"done"
    walIntent,           \* "none" | "spawn" | "feedback" | "block"
    walReceipt,          \* "none" | "spawn" | "feedback" | "block"
    worktreeReserved,    \* долговечная бронь worktree (slot.mjs)
    liveWriters,         \* множество РЕАЛЬНО живых писателей (эпохи)
    spawnOnWire,         \* spawn отправлен, но эффект ещё не наблюдаем/не зачислен
    feedbackWire,        \* "idle" | "on_wire" | "delivered" — машина доставки feedback
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
    progressMade,        \* был ли зарегистрирован реальный прогресс
    production           \* bounded hc/queue/scheduler projection (see ProductionNext)

walVars == <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent, walReceipt,
          worktreeReserved, liveWriters, spawnOnWire, feedbackWire, spawnCount,
          candidateDigest, verifiedDigest, activePolicyDigest, pinnedPolicyDigest,
          lastTurnSeq, feedbackWatermark, acceptedTurnSeq, commitEpoch,
          reworkRounds, progressMade>>

vars == <<walVars, production>>

\* A second finite projection of the same route. Scheduler locks are sets of
\* canonical (repo,path) atoms: a prefix/unknown scope covers its descendants.
\* Tasks 1 and 2 overlap, 3 can run concurrently, 4 is repo-exclusive.
Footprint(t) == CASE t = 1 -> {"src/a", "src/b"} [] t = 2 -> {"src/a"}
                  [] t = 3 -> {"docs"} [] OTHER -> {"src/a", "src/b", "docs"}
ProductionFault == "none"  \* overridden one guard at a time by TLC config
ProdInit == [held |-> {}, stage |-> "idle", attested |-> FALSE,
             reviewed |-> FALSE, protected |-> FALSE, approved |-> FALSE,
             head |-> "base", expected |-> "base", previous |-> "none",
             rebased |-> FALSE, smokeSha |-> "none"]

ResetAttempt ==
    /\ walIntent' = "none" /\ walReceipt' = "none"
    /\ spawnOnWire' = FALSE /\ feedbackWire' = "idle"
    /\ candidateDigest' = "none" /\ verifiedDigest' = "none"
    /\ lastTurnSeq' = 0 /\ feedbackWatermark' = 0 /\ acceptedTurnSeq' = 0
    /\ reworkRounds' = 0 /\ progressMade' = FALSE

Init ==
    /\ production = ProdInit
    /\ boardState = "ready" /\ boardEpoch = 0 /\ leaseAlive = FALSE
    /\ ctrlPhase = "idle" /\ walIntent = "none" /\ walReceipt = "none"
    /\ worktreeReserved = FALSE /\ liveWriters = {}
    /\ spawnOnWire = FALSE /\ feedbackWire = "idle"
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
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* --- Spawn: intent -> send -> effect -> receipt -> reconcile -----------------

SpawnIntent ==
    /\ ctrlPhase = "claimed" /\ walIntent = "none"
    /\ walIntent' = "spawn" /\ ctrlPhase' = "launching"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Вызов bb.spawn. Первый send — только из "launching" с нулём уже посланных.
\* Повторный send возможен только из "launching_retry", куда контроллер
\* попадает исключительно через Crash -> ReconcileSpawnEmpty мутанта 2:
\* последовательность SpawnSend -> SpawnSend без рестарта и пустой сверки
\* в модели невозможна.
SpawnSend ==
    /\ walIntent = "spawn"
    /\ \/ /\ ctrlPhase = "launching" /\ ~spawnOnWire /\ spawnCount[boardEpoch] = 0
       \/ /\ AllowRetryOnEmptyObservation    \* мутант 2: слепой повторный send
          /\ ctrlPhase = "launching_retry"
    /\ ctrlPhase' = "launching"
    /\ spawnOnWire' = TRUE
    /\ spawnCount' = [spawnCount EXCEPT ![boardEpoch] = @ + 1]
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walIntent,
                   walReceipt, worktreeReserved, liveWriters, feedbackWire,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Эффект дошёл до внешнего мира: писатель реально жив (наблюдаемая сущность).
SpawnEffect ==
    /\ ctrlPhase = "launching" /\ spawnOnWire
    /\ liveWriters' = liveWriters \cup {boardEpoch}
    /\ spawnOnWire' = FALSE
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, feedbackWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Ack получен: receipt записан, переход в working.
SpawnReceipt ==
    /\ ctrlPhase = "launching" /\ walIntent = "spawn"
    /\ ~spawnOnWire /\ boardEpoch \in liveWriters
    /\ walReceipt' = "spawn" /\ walIntent' = "none" /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Обрыв процесса в любой IN_FLIGHT/рабочей фазе: запросы могут остаться на
\* проводе ненаблюдаемыми; WAL intent/receipt переживает крах.
Crash ==
    /\ ctrlPhase \in {"claimed", "launching", "launching_retry", "working", "checking", "returning", "blocking"}
    /\ ctrlPhase' = "restarting"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
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
                THEN /\ ctrlPhase' = "launching_retry"    \* обратно к LaunchSpawn
                     /\ UNCHANGED <<walIntent, walReceipt, liveWriters>>
                ELSE /\ ctrlPhase' = "uncertain"
                     /\ UNCHANGED <<walIntent, walReceipt, liveWriters>>
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   spawnOnWire, feedbackWire, spawnCount, candidateDigest,
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
                   feedbackWire, spawnCount, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, feedbackWatermark, acceptedTurnSeq,
                   commitEpoch, reworkRounds, progressMade>>

\* Возврат на доработку: durable intent feedback, фаза returning. Как в
\* controller.mjs, запись нового intent сбрасывает receipt и машину провода.
FeedbackIntent ==
    /\ ctrlPhase = "checking" /\ walIntent = "none" /\ reworkRounds < 3
    /\ walIntent' = "feedback" /\ walReceipt' = "none" /\ feedbackWire' = "idle"
    /\ ctrlPhase' = "returning"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive,
                   worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

FeedbackSend ==
    /\ ctrlPhase = "returning" /\ walIntent = "feedback" /\ feedbackWire = "idle"
    /\ feedbackWire' = "on_wire"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Внешний эффект: замечание доставлено — watermark сдвинулся в мире.
\* "delivered" терминален для провода: повторный FeedbackSend невозможен.
FeedbackDelivered ==
    /\ ctrlPhase = "returning" /\ feedbackWire = "on_wire"
    /\ feedbackWire' = "delivered" /\ feedbackWatermark' = lastTurnSeq
    /\ acceptedTurnSeq' = 0    \* израсходованный ответ не считается новым ходом
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, commitEpoch,
                   reworkRounds, progressMade>>

\* Ack получен: receipt, возврат в working; прежний ответ израсходован.
\* Разрешён только при подтверждённой доставке (feedbackWire = "delivered").
FeedbackReceipt ==
    /\ ctrlPhase = "returning" /\ walIntent = "feedback"
    /\ feedbackWire = "delivered" /\ feedbackWatermark = lastTurnSeq
    /\ walReceipt' = "feedback" /\ walIntent' = "none"
    /\ reworkRounds' = reworkRounds + 1 /\ acceptedTurnSeq' = 0
    /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   commitEpoch, progressMade>>

\* Потерянный ack feedback: read-only сверка журнала треда. Ровно одно
\* подтверждённое сообщение (эффект доставлен, watermark сдвинут) при живой
\* аренде -> adopt в working без повторного tell.
ReconcileFeedbackDelivered ==
    /\ ctrlPhase = "restarting" /\ walIntent = "feedback" /\ walReceipt = "none"
    /\ leaseAlive /\ feedbackWire = "delivered"
    /\ feedbackWatermark = lastTurnSeq /\ lastTurnSeq > 0
    /\ walReceipt' = "feedback" /\ walIntent' = "none"
    /\ reworkRounds' = reworkRounds + 1 /\ acceptedTurnSeq' = 0
    /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   commitEpoch, progressMade>>

\* Пустая/неоднозначная выдача (эффект не отправлен или ещё на проводе) или
\* потерянная аренда -> uncertain без повторного tell.
ReconcileFeedbackEmpty ==
    /\ ctrlPhase = "restarting" /\ walIntent = "feedback" /\ walReceipt = "none"
    /\ \/ ~leaseAlive
       \/ feedbackWire \in {"idle", "on_wire"}
       \/ feedbackWatermark # lastTurnSeq
    /\ ctrlPhase' = "uncertain"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* --- Блокировка: intent -> эффект на карточке -> receipt -> reconcile --------

\* Нарушение протокола хода/политики: durable intent block, фаза blocking.
\* Запись нового intent сбрасывает receipt (как save() в controller.mjs).
BlockIntent ==
    /\ ctrlPhase = "working" /\ walIntent = "none"
    /\ walIntent' = "block" /\ walReceipt' = "none" /\ ctrlPhase' = "blocking"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Внешний эффект: карточка реально переведена в blocked (board.block дошёл).
BlockDelivered ==
    /\ ctrlPhase = "blocking" /\ walIntent = "block" /\ boardState = "claimed"
    /\ boardState' = "blocked"
    /\ UNCHANGED <<boardEpoch, leaseAlive, ctrlPhase, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Ack получен: receipt, переход в hold.
BlockReceipt ==
    /\ ctrlPhase = "blocking" /\ walIntent = "block" /\ boardState = "blocked"
    /\ walReceipt' = "block" /\ walIntent' = "none" /\ ctrlPhase' = "hold"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, worktreeReserved,
                   liveWriters, spawnOnWire, feedbackWire, spawnCount,
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
                   liveWriters, spawnOnWire, feedbackWire, spawnCount,
                   candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* Наблюдение хода воркера: контроллер покидает "working" в "checking".
\* База игнорирует ход не новее watermark; мутант 4 принимает replay
\* lastTurnSeq <= feedbackWatermark как ответ и уходит на проверку —
\* NoWatermarkRegression нарушается на самом переходе.
AcceptTurn ==
    /\ ctrlPhase = "working"
    /\ \/ /\ lastTurnSeq > feedbackWatermark
          /\ acceptedTurnSeq' = lastTurnSeq
          /\ progressMade' = TRUE
          /\ ctrlPhase' = "checking"        \* новый ход -> проверка
          /\ UNCHANGED <<walIntent, walReceipt>>
       \/ /\ AllowStaleTurnWatermark        \* мутант 4: replay старого хода
          /\ feedbackWatermark > 0
          /\ lastTurnSeq > 0
          /\ lastTurnSeq <= feedbackWatermark
          \* Старый ход без новой сдачи принят как ответ: нарушение протокола
          \* хода ведёт сразу в blocking с durable intent (controller.mjs
          \* stopWith при повторе seenShas/отсутствии нового handoff).
          /\ acceptedTurnSeq' = lastTurnSeq
          /\ ctrlPhase' = "blocking"
          /\ walIntent' = "block" /\ walReceipt' = "none"
          /\ UNCHANGED progressMade
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive,
                   worktreeReserved, liveWriters, spawnOnWire,
                   feedbackWire, spawnCount, candidateDigest, verifiedDigest,
                   activePolicyDigest, pinnedPolicyDigest, lastTurnSeq,
                   feedbackWatermark, commitEpoch, reworkRounds>>

\* Проверка хода завершена — контроллер снова ждёт следующий ход.
CheckDone ==
    /\ ctrlPhase = "checking" /\ ctrlPhase' = "working"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, walIntent, walReceipt,
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

\* --- Проверка, seal и complete ------------------------------------------------

Verify ==
    /\ ctrlPhase = "checking" /\ candidateDigest = "cand" /\ verifiedDigest = "none"
    /\ verifiedDigest' = "cand" /\ progressMade' = TRUE
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   feedbackWire, spawnCount, candidateDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds>>

ChangePolicy ==
    /\ boardState = "claimed" /\ activePolicyDigest = "p1" /\ activePolicyDigest' = "p2"
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, liveWriters, spawnOnWire,
                   feedbackWire, spawnCount, candidateDigest, verifiedDigest,
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
                   worktreeReserved, liveWriters, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, reworkRounds, progressMade>>

\* Старый писатель действительно умирает — только тогда слот может быть отдан.
WriterDies(e) ==
    /\ e \in liveWriters /\ liveWriters' = liveWriters \ {e}
    /\ UNCHANGED <<boardState, boardEpoch, leaseAlive, ctrlPhase, walIntent,
                   walReceipt, worktreeReserved, spawnOnWire, feedbackWire,
                   spawnCount, candidateDigest, verifiedDigest, activePolicyDigest,
                   pinnedPolicyDigest, lastTurnSeq, feedbackWatermark,
                   acceptedTurnSeq, commitEpoch, reworkRounds, progressMade>>

WalNext ==
    \/ Claim \/ Takeover \/ LeaseExpires
    \/ SpawnIntent \/ SpawnSend \/ SpawnEffect \/ SpawnReceipt
    \/ Crash \/ ReconcileSpawn \/ ReconcileFeedbackDelivered \/ ReconcileFeedbackEmpty \/ ReconcileBlock
    \/ WorkerTurn \/ FeedbackIntent \/ FeedbackSend \/ FeedbackDelivered \/ FeedbackReceipt
    \/ BlockIntent \/ BlockDelivered \/ BlockReceipt
    \/ AcceptTurn \/ CheckDone \/ Verify \/ ChangePolicy \/ Complete
    \/ \E e \in 1..MaxEpoch : WriterDies(e)

\* Task 1 represents the hc writer. Its launch receipt is usable only after
\* runHc observes a terminal address. The reservation survives missing acks.
Reserve(t) ==
    /\ t \notin production.held
    /\ ProductionFault = "scope" \/
       (\A s \in production.held : Footprint(t) \cap Footprint(s) = {})
    /\ production' = [production EXCEPT !.held = @ \cup {t}]

HcLaunch ==
    /\ production.stage = "idle" /\ 1 \in production.held
    /\ \E ack \in BOOLEAN : production' = [production EXCEPT
            !.stage = "launching", !.attested = ack]
HcReceipt ==
    /\ production.stage = "launching"
    /\ production.attested \/ ProductionFault = "hc"
    /\ production' = [production EXCEPT !.stage = "working"]

\* The queue snapshots the integration ref; a competing slot can move it
\* before update-ref. A rebase creates a DIFFERENT subject needing fresh L1.
Enqueue ==
    /\ production.stage = "working"
    /\ \E reviewed, prot, approved, rebase \in BOOLEAN :
        production' = [production EXCEPT !.stage = "queued", !.expected = production.head,
            !.reviewed = reviewed, !.protected = prot, !.approved = approved,
            !.rebased = rebase, !.smokeSha = "candidate"]
MergeUpdate ==
    /\ production.stage = "queued"
    /\ production.reviewed \/ ProductionFault = "review"
    /\ ~production.protected \/ production.approved \/ ProductionFault = "owner"
    /\ production.expected = production.head \/ ProductionFault = "cas"
    /\ ~production.rebased \/ production.smokeSha = "rebased" \/ ProductionFault = "smoke"
    /\ production' = [production EXCEPT !.stage = "merged", !.previous = production.head,
            !.head = IF production.rebased THEN "rebased" ELSE "candidate"]

ProductionNext ==
    \/ \E t \in 1..4 : Reserve(t)
    \/ \E t \in production.held \ {1} : production' = [production EXCEPT !.held = @ \ {t}]
    \/ HcLaunch \/ HcReceipt \/ Enqueue \/ MergeUpdate
    \/ /\ production.stage = "queued" /\ production.head = "base"
       /\ production' = [production EXCEPT !.head = "competing"]
    \/ /\ production.stage = "queued" /\ production.rebased /\ production.smokeSha # "rebased"
       /\ production' = [production EXCEPT !.smokeSha = "rebased"]

\* Explore the two projections as a union, not their Cartesian product.
Next == \/ /\ production = ProdInit /\ WalNext /\ UNCHANGED production
        \/ /\ ctrlPhase = "idle" /\ ProductionNext /\ UNCHANGED walVars
        \/ UNCHANGED vars  \* Safety only: waiting/quarantine is an intentional idle tick.
Spec == Init /\ [][Next]_vars

ScopeLocksDisjoint == \A t, s \in production.held :
    t # s => Footprint(t) \cap Footprint(s) = {}
HcReceiptAttested == production.stage \in {"working", "queued", "merged"} => production.attested
MergeReviewed == production.stage = "merged" => production.reviewed
MergeAuthorized == production.stage = "merged" /\ production.protected => production.approved
MergeHeadCurrent == production.stage = "merged" => production.previous = production.expected
RebaseSmokePassed == production.stage = "merged" /\ production.rebased => production.smokeSha = production.head

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
