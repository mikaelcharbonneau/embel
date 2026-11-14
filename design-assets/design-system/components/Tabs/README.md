# Tabs and segmented control

Switching between views of one page. You provide the labels and which one is selected.

- **Underline tabs**: sections of a page (Settings: Account, Usage; Library: Kept assets, All generations). The selected tab is ink with a 2 px ink underline; the others are muted and gain a grey underline on hover.
- **Segmented control**: switching a view in place (gallery categories, name availability). The selected segment is an ink pill with white text.
- 44 px tall. One tab stop; arrow keys move and select; each tab controls a labelled panel (`role="tablist"`, `tab`, `tabpanel`).
- Tabs do not animate.
