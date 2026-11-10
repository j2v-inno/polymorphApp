/**
 * What this app uses of Orion's External page, declared from Orion's contract
 * (version 1, "The External page: what an outside app passes in and hears
 * back"). Orion does not publish these types yet, so they are written here
 * and nothing is imported from Orion.
 */
export type OrionTheme = 'dark' | 'light';

/** Who Orion recognises in this browser, through the stand-in below. */
export interface OrionOperator {
  name: string;
  email: string;
}

export interface OrionExternalPageProps {
  theme?: OrionTheme;
  /** This app's Web App code in Orion. Process is live only on tasks that use it. */
  webApp?: string;
  /**
   * Stand-in for the contract's `operator-changed` event, until Orion builds
   * its event bus. Called with the operator, or null when nobody is signed in
   * to Orion, each time the answer changes; not called until Orion answers.
   */
  onOperatorChange?: (operator: OrionOperator | null) => void;
}

export interface OrionExternalPage {
  /** A prop left out keeps its value. */
  update: (props: OrionExternalPageProps) => void;
  unmount: () => void;
}

export interface OrionEntry {
  mountOrion: (element: HTMLElement, props?: OrionExternalPageProps) => OrionExternalPage;
}
