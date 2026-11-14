# Button

The one way to trigger an action. You provide the label (a verb, sentence case), the variant, and optionally a leading icon.

- **Primary** (ink fill): the one main action of a view. At most one per view or dialog.
- **Secondary** (paper, hairline): every other action.
- **Quiet** (no border): low-emphasis actions beside a primary, such as "Not now".
- **Danger** (outlined): starts a destructive flow. **Danger-filled** appears only as the final button of a destructive confirmation.
- Sizes: 44 px (`button-height`) and 36 px (`button-height-sm`, pointer devices, with a 44 px touch target).
- A trailing arrow only on buttons that go to another page. A plus or other icon leads the label.
- Width: buttons hug their label. Use full width only for the single action of a narrow form, and for dialog actions at compact width.
- Loading: set `aria-busy="true"` and `aria-disabled="true"`, keep the label, add the spinner. Never `disabled`, so focus stays on the button.
- Do not disable a button to signal an incomplete form; let it explain on press. Any disabled button has its reason in text beside it.
- Radius is `radius-control`, the same as fields. Buttons are never pills.
