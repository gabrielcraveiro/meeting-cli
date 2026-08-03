type Props = {
  message: string;
  onRetry?: () => void;
};

export function ErrorBanner({ message, onRetry }: Props) {
  return (
    <div className="banner" role="status">
      <span>{message}</span>
      {onRetry && (
        <button className="banner-action" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}
