# visual-rubric — Satisfaction Testing для ux-visual-critic

## Жёсткие блокеры
- `unstyledControls`: нативный вид контрола или контрол вне дизайн-системы.
  Порог: **0**.
- `uncollapsedLongLists`: список/таблица длиннее **10** видимых элементов без
  свёртки, пагинации или виртуализации. Порог: **0**.
- `missingStates`: `loading`, `empty`, `error` или `ready` не показан/не доступен.
  Порог: **0**.
- `consoleErrors`, `a11yViolations`, `a11yCritical`: любое значение >0 — blocker.
- `holdoutFailures`: любой провал скрытого сценария — blocker.
- `satisfactionScore`: ниже **85** — REWORK даже при нулевых счётчиках.

## Обязательные viewport
Оценивай отдельно `1440x900` и `1024x768`. Нет PNG одного viewport — покрытие
неполное, PASS запрещён. Для каждого вычета укажи viewport.

## Балл
Начинай со 100 и вычитай только наблюдаемое:
- blocker по контролу/списку/состоянию/a11y/holdout: минимум 15 за категорию;
- визуальная иерархия нечитаема или primary action теряется: 10–20;
- overflow, наложение, случайная сетка/типографика: 5–15 по тяжести;
- мелкая полировка без нарушения сценария: не более 5 и не блокирует сама по себе.

Не поднимай итог до 85 «в целом». Итог — сумма пунктов, каждый с capture и областью.

## Координаты REWORK
Каждая blocking violation обязана быть actionable для воркера без раскрытия
holdout: category, viewport, CSS selector или bounding box `x/y/width/height`.
Текст сценария, путь файла, секрет, host path и ANSI escape в violation запрещены.
