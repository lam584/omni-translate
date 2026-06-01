import type { ReactNode } from 'react';

type PageSectionHeaderProps = {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  copyClassName?: string;
  actionsClassName?: string;
  titleLevel?: 'h2' | 'h3';
};

function joinClassNames(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function PageSectionHeader({
  title,
  description,
  actions,
  className,
  copyClassName,
  actionsClassName,
  titleLevel = 'h3',
}: PageSectionHeaderProps) {
  const TitleTag = titleLevel;

  return (
    <div className={joinClassNames('page-section-header', className)}>
      {title || description ? (
        <div className={joinClassNames('page-section-header-copy', copyClassName)}>
          {title ? <TitleTag>{title}</TitleTag> : null}
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}

      {actions ? <div className={joinClassNames('page-section-header-actions', actionsClassName)}>{actions}</div> : null}
    </div>
  );
}

export default PageSectionHeader;