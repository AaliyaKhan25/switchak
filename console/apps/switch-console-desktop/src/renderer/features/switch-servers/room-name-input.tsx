/** The new room's name, large as its title; Enter submits, except an Enter the IME is handling. */
export function RoomNameInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <input
      autoFocus
      aria-label="Room name"
      placeholder="Room name"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // keyCode 229: a key the IME is handling, which some IMEs send with isComposing false.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') onSubmit();
      }}
      className="w-full border-b border-border bg-transparent pb-2 text-xl font-semibold text-foreground outline-none placeholder:font-normal placeholder:text-foreground-passive focus:border-foreground-muted"
    />
  );
}
