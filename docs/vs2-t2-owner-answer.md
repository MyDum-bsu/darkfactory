# VS-2 T2: QuestionEnvelope и возобновление

Профиль включается только в `run-isolated.mjs` на отдельной loopback Board, не на `:44100`. У этой Board должен быть **один доверенный писатель** для карточек пилота: независимые владельцы/manage и другой контроллер не меняют hold/claim параллельно. В Board 0.54.0 `tasks.unblock(id)` идемпотентен, но не имеет атомарного `expectedEpoch`/ID блокировки; чтение перед вызовом не заменяет CAS. Этот профиль не готов для многопользовательской живой Board.

В доверенной политике укажите владельца карточки в `owner` и задайте:

```json
{
  "questionGate": {
    "exclusiveBoardOwner": true,
    "inbox": "/path/to/operator-answer-inbox",
    "ttlMs": 3600000,
    "publicKey": "-----BEGIN PUBLIC KEY-----\n<Ed25519 SPKI PEM>\n-----END PUBLIC KEY-----\n"
  }
}
```

Каталог ответов находится вне worktree и каталога сдачи. Закрытый Ed25519-ключ остаётся у владельца: он не монтируется и не записывается на машине контроллера. `owner`, ключ и конфигурация входят в закреплённую политику. Текст карточки, сообщение BB, затёртый идентификатор и ответ, подписанный чужим ключом, полномочий не дают.

1. Для продуктовой развилки воркер сдаёт `question: {"prompt":"…","evidence":"…"}` вместо `candidate_sha`, сохраняя `task_id`, `epoch`, `attempt_id` и `worker_thread_id` текущей попытки. Только один конкретный вопрос, без сырых логов и секретов. Для выпуска вопрос формируется контроллером после верификации и seal и содержит точные SHA и `subject_digest`.
2. `blocked(needs_input)` содержит JSON `QuestionEnvelope`. Владелец читает его целиком в `question.json`, проверяет контекст и подписывает ровно этот вопрос. Допустимые решения: `resolve` и непустой `answer` (product); `approve` и пустой `answer` (release); `decline` с пустым `answer` (сохраняет блокировку). Пример на машине владельца:

```sh
node --input-type=module - question.json /offline/owner-key.pem resolve 'Выбираем CSV.' <<'JS'
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { answerBytes } from './board_pipeline/question-gate.mjs';
const [questionPath, keyPath, decision, answer] = process.argv.slice(2);
const question = JSON.parse(readFileSync(questionPath, 'utf8'));
const reply = { decision, answer };
const signature = sign(null, answerBytes(question, reply), readFileSync(keyPath)).toString('base64url');
process.stdout.write(JSON.stringify({ ...reply, signature }));
JS
```

3. Передайте подписанный JSON атомарным rename как `<question_id>.json` в `inbox`. Работающий foreground-контроллер подхватит его; после остановки запускается с тем же `--state` и теми же входами. Истёкший, повреждённый или подписанный для другого вопроса ответ не снимает hold. После durable intent вызывается native unblock один раз. При потере ack контроллер сверяет прежнюю эпоху и `ready`/`waiting`; неясность оставляет карантин и не повторяет write. Следующий claim закреплён за той же карточкой, получает свежий token, точный следующий `epoch` и новый `attempt_id`.
4. Product: возобновляется тот же BB-тред. Проверяются чистый HEAD/ветка, совпадение watermark завершённого хода, отсутствие активных фоновых агентов и очереди в BB. Резервирование слота сохраняется, второй кодер не запускается. Release: `release_ready` и новая аренда без `spawn`, `tell`, `deploy` или `complete`; подписанное решение не является `ApprovalReceipt` или полномочием выкладки. P1.2–P1.3 остаются в T4.

`npm run test:integration` проверяет настоящие loopback Board, файловую систему, Docker и conformance без модельных запросов. `npm run test:live:review` — отдельный обязательный гейт T1 с реальными Pi/Sol и Neon; детерминированный прогон его не заменяет.
