// AppHeaderBrand — left-side brand block for <ix-application-header>.
//
// Rendered into `slot="logo"`, it replaces iX's default logo + name layout
// with a single horizontal row:
//
//   LOGO  |  App Name
//
// App.tsx therefore omits the `name` prop on IxApplicationHeader; iX's
// internal name div renders empty and stays invisible. The brand mark is the
// `<ix-siemens-logo>` custom element registered by the corporate brand theme —
// main.tsx must import the component JS for it to render.
import { Link } from "react-router";
import styles from "./AppHeaderBrand.module.css";

type AppHeaderBrandProps = {
  name: string;
};

const AppHeaderBrand = ({ name }: AppHeaderBrandProps) => {
  return (
    <div slot="logo" className={styles.brand}>
      <Link to="/" className={styles.logoLink} aria-label="Go to start page">
        {/* @ts-expect-error — ix-siemens-logo is a brand-theme web component without TS JSX types */}
        <ix-siemens-logo />
      </Link>
      <span className={styles.separator} aria-hidden="true" />
      <span className={styles.name}>{name}</span>
    </div>
  );
};

export default AppHeaderBrand;
