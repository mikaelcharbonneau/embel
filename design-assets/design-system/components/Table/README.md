# Table

Rows of comparable data. You provide a caption, the column headers and the rows.

- Always a real `<table>` with a `<caption>` and `<th scope="col">`. A list of colour tokens is a table too.
- Rows 48 px. Text columns align left; numeric columns align right with tabular figures.
- Row hover (pointer only) is `color-bg-hover`. A sortable header is a button; the sorted column sets `aria-sort` and shows an arrow.
- Loading shows skeleton rows of the same height. Empty shows one sentence in place of the rows.
- Below 640 px each row stacks into a card and every cell carries its column name (`data-label`).
