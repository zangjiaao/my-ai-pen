type Props = {
  controls: number[];
  trailingWidth?: number;
  label: string;
  testId: string;
};

export default function PageToolbarSkeleton({
  controls,
  trailingWidth,
  label,
  testId,
}: Props) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid={testId}
      className="mb-4 flex flex-wrap items-center gap-3 animate-pulse"
    >
      {controls.map((width, index) => (
        <div
          key={`${width}-${index}`}
          aria-hidden="true"
          className="h-10 rounded-md border border-hairline bg-surface"
          style={{ width: `${width}px` }}
        />
      ))}
      {trailingWidth ? (
        <div
          aria-hidden="true"
          className="ml-auto h-10 rounded-md bg-canvas-inset"
          style={{ width: `${trailingWidth}px` }}
        />
      ) : null}
    </div>
  );
}
