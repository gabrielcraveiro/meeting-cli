type Props = {
  message: string;
  onRetry?: () => void;
  /** Ação alternativa (ex.: "Iniciar daemon") — substitui o "Tentar de novo". */
  actionLabel?: string;
  onAction?: () => void;
};

export function ErrorBanner({ message, onRetry, actionLabel, onAction }: Props) {
  const action =
    actionLabel && onAction
      ? { label: actionLabel, run: onAction }
      : onRetry
        ? { label: 'Tentar de novo', run: onRetry }
        : null;

  return (
    <div className="banner" role="status">
      <span>{message}</span>
      {action && (
        <button className="banner-action" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
