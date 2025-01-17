import {
  CUSTOM_INTERACTIONS,
  DESCOPE_ATTRIBUTE_EXCLUDE_FIELD,
  DESCOPE_ATTRIBUTE_EXCLUDE_NEXT_BUTTON,
  ELEMENT_TYPE_ATTRIBUTE,
  RESPONSE_ACTIONS,
} from '../constants';
import {
  fetchContent,
  generateFnsFromScriptTags,
  getAnimationDirection,
  getContentUrl,
  getElementDescopeAttributes,
  getInputValueByType,
  handleAutoFocus,
  injectSamlIdpForm,
  isChromium,
  isConditionalLoginSupported,
  replaceWithScreenState,
  setTOTPVariable,
  showFirstScreenOnExecutionInit,
  State,
  submitForm,
  withMemCache,
} from '../helpers';
import { calculateConditions, calculateCondition } from '../helpers/conditions';
import { getLastAuth, setLastAuth } from '../helpers/lastAuth';
import { IsChanged } from '../helpers/state';
import { disableWebauthnButtons } from '../helpers/templates';
import {
  Direction,
  FlowState,
  NextFn,
  NextFnReturnPromiseValue,
  SdkConfig,
  StepState,
} from '../types';
import BaseDescopeWc from './BaseDescopeWc';

// this class is responsible for WC flow execution
class DescopeWc extends BaseDescopeWc {
  errorTransformer:
    | ((error: { text: string; type: string }) => string)
    | undefined;

  static set sdkConfigOverrides(config: Partial<SdkConfig>) {
    BaseDescopeWc.sdkConfigOverrides = config;
  }

  flowState: State<FlowState>;

  stepState = new State<StepState>({} as StepState, {
    updateOnlyOnChange: false,
  });

  #currentInterval: NodeJS.Timeout;

  #conditionalUiAbortController = null;

  constructor() {
    const flowState = new State<FlowState>();
    super(flowState.update.bind(flowState));

    this.flowState = flowState;
  }

  async connectedCallback() {
    if (this.shadowRoot.isConnected) {
      this.flowState?.subscribe(this.onFlowChange.bind(this));
      this.stepState?.subscribe(this.onStepChange.bind(this));
    }
    await super.connectedCallback();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.flowState.unsubscribeAll();
    this.stepState.unsubscribeAll();

    this.#conditionalUiAbortController?.abort();
    this.#conditionalUiAbortController = null;
  }

  async getHtmlFilenameWithLocale(locale: string, screenId: string) {
    let filenameWithLocale: string;
    let browserLocale = navigator.language;
    if (browserLocale && browserLocale !== 'zh-TW') {
      // zh-TW is the only locale that must have "-", for all others we need to have the first part
      browserLocale = browserLocale.split('-')[0]; // eslint-disable-line
    }
    const userLocale = (locale || browserLocale || '').toLowerCase(); // use provided locals, otherwise use browser locale
    const targetLocales = await this.getTargetLocales();

    if (targetLocales.includes(userLocale)) {
      filenameWithLocale = `${screenId}-${userLocale}.html`;
    }
    return filenameWithLocale;
  }

  async getPageContent(htmlUrl: string, htmlLocaleUrl: string) {
    if (htmlLocaleUrl) {
      // try first locale url, if can't get for some reason, fallback to the original html url (the one without locale)
      try {
        const { body } = await fetchContent(htmlLocaleUrl, 'text');
        return body;
      } catch (ex) {
        this.loggerWrapper.error(
          `Failed to fetch html page from ${htmlLocaleUrl}. Fallback to url ${htmlUrl}`,
          ex
        );
      }
    }

    try {
      const { body } = await fetchContent(htmlUrl, 'text');
      return body;
    } catch (ex) {
      this.loggerWrapper.error(`Failed to fetch html page from ${htmlUrl}`, ex);
    }
    return null;
  }

  async onFlowChange(
    currentState: FlowState,
    prevState: FlowState,
    isChanged: IsChanged<FlowState>
  ) {
    const {
      projectId,
      flowId,
      tenant,
      stepId,
      executionId,
      action,
      screenId,
      screenState,
      redirectTo,
      redirectUrl,
      token,
      code,
      exchangeError,
      webauthnTransactionId,
      webauthnOptions,
      redirectAuthCodeChallenge,
      redirectAuthCallbackUrl,
      redirectAuthInitiator,
      oidcIdpStateId,
      locale,
      samlIdpStateId,
      samlIdpUsername,
      samlIdpResponseUrl,
      samlIdpResponseSamlResponse,
      samlIdpResponseRelayState,
      ssoAppId,
    } = currentState;

    if (this.#currentInterval) {
      this.#resetCurrentInterval();
    }

    let startScreenId: string;
    let conditionInteractionId: string;
    const loginId = this.sdk.getLastUserLoginId();
    const flowConfig = await this.getFlowConfig();

    const redirectAuth =
      redirectAuthCallbackUrl && redirectAuthCodeChallenge
        ? {
            callbackUrl: redirectAuthCallbackUrl,
            codeChallenge: redirectAuthCodeChallenge,
          }
        : undefined;

    // if there is no execution id we should start a new flow
    if (!executionId) {
      if (flowConfig.conditions) {
        ({ startScreenId, conditionInteractionId } = calculateConditions(
          { loginId, code, token },
          flowConfig.conditions
        ));
      } else if (flowConfig.condition) {
        ({ startScreenId, conditionInteractionId } = calculateCondition(
          flowConfig.condition,
          { loginId, code, token }
        ));
      } else {
        startScreenId = flowConfig.startScreenId;
      }

      // As an optimization - we want to show the first screen if it is possible
      if (
        !showFirstScreenOnExecutionInit(
          startScreenId,
          oidcIdpStateId,
          samlIdpStateId,
          samlIdpUsername,
          ssoAppId
        )
      ) {
        const inputs: Record<string, any> = {};
        let exists = false;
        if (code) {
          exists = true;
          inputs.exchangeCode = code;
          inputs.idpInitiated = true;
        }
        if (token) {
          exists = true;
          inputs.token = token;
        }
        const sdkResp = await this.sdk.flow.start(
          flowId,
          {
            tenant,
            redirectAuth,
            oidcIdpStateId,
            samlIdpStateId,
            samlIdpUsername,
            ssoAppId,
            ...(redirectUrl && { redirectUrl }),
            lastAuth: getLastAuth(loginId),
          },
          conditionInteractionId,
          '',
          exists ? inputs : undefined,
          flowConfig.version
        );

        this.#handleSdkResponse(sdkResp);
        if (sdkResp?.data?.status !== 'completed') {
          this.flowState.update({ code: undefined, token: undefined });
        }
        return;
      }
    }

    // if there is a descope url param on the url its because the user clicked on email link or redirected back to the app
    // we should call next with the params
    if (
      executionId &&
      ((isChanged('token') && token) ||
        (isChanged('code') && code) ||
        (isChanged('exchangeError') && exchangeError))
    ) {
      const sdkResp = await this.sdk.flow.next(
        executionId,
        stepId,
        CUSTOM_INTERACTIONS.submit,
        {
          token,
          exchangeCode: code,
          exchangeError,
        },
        flowConfig.version
      );
      this.#handleSdkResponse(sdkResp);
      this.flowState.update({
        token: undefined,
        code: undefined,
        exchangeError: undefined,
      }); // should happen after handleSdkResponse, otherwise we will not have screen id on the next run
      return;
    }

    const samlProps = [
      'samlIdpResponseUrl',
      'samlIdpResponseSamlResponse',
      'samlIdpResponseRelayState',
    ];
    if (
      action === RESPONSE_ACTIONS.loadForm &&
      samlProps.some((samlProp) => isChanged(samlProp))
    ) {
      if (!samlIdpResponseUrl || !samlIdpResponseSamlResponse) {
        this.loggerWrapper.error('Did not get saml idp params data to load');
        return;
      }

      // Handle SAML IDP end of flow ("redirect like" by using html form with hidden params)
      injectSamlIdpForm(
        samlIdpResponseUrl,
        samlIdpResponseSamlResponse,
        samlIdpResponseRelayState || '',
        submitForm
      ); // will redirect us to the saml acs url
    }

    if (
      action === RESPONSE_ACTIONS.redirect &&
      (isChanged('redirectTo') || isChanged('deferredRedirect'))
    ) {
      if (!redirectTo) {
        this.loggerWrapper.error('Did not get redirect url');
        return;
      }
      if (redirectAuthInitiator === 'android' && document.hidden) {
        // on android native flows, defer redirects until in foreground
        this.flowState.update({
          deferredRedirect: true,
        });
        return;
      }
      window.location.assign(redirectTo);
      return;
    }

    if (
      action === RESPONSE_ACTIONS.webauthnCreate ||
      action === RESPONSE_ACTIONS.webauthnGet
    ) {
      if (!webauthnTransactionId || !webauthnOptions) {
        this.loggerWrapper.error(
          'Did not get webauthn transaction id or options'
        );
        return;
      }

      // we override the default webauthn options to only use platform authenticators (i.e., builtin biometrics)
      // when registering a new webauthn credential if we're running on Chrome and the device actually has such
      // an authenticator. this makes it so in Chrome when the passkeys dialog pops up the user is immediately
      // offered to use biometrics, rather than having to select it from several options. this behavior is enabled
      // by default but can be disabled on the web-component itsel by setting prefer-biometrics="false".
      let options = webauthnOptions;
      if (
        this.preferBiometrics &&
        action === RESPONSE_ACTIONS.webauthnCreate &&
        isChromium() &&
        (await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.())
      ) {
        try {
          const json = JSON.parse(options);
          if (json.publicKey) {
            json.publicKey.authenticatorSelection ||= {};
            json.publicKey.authenticatorSelection.authenticatorAttachment ||=
              'platform';
            options = JSON.stringify(json);
          }
        } catch (e) {
          // if options could not be parsed we ignore it here so this kind of error is always handled the same way
          this.loggerWrapper.info('Failed to modify webauthn create options');
        }
      }

      this.#conditionalUiAbortController?.abort();
      this.#conditionalUiAbortController = null;

      let response: string;
      let cancelWebauthn;
      try {
        response =
          action === RESPONSE_ACTIONS.webauthnCreate
            ? await this.sdk.webauthn.helpers.create(options)
            : await this.sdk.webauthn.helpers.get(options);
      } catch (e) {
        if (e.name !== 'NotAllowedError') {
          this.loggerWrapper.error(e.message);
          return;
        }

        cancelWebauthn = true;
      }
      // Call next with the response and transactionId
      const sdkResp = await this.sdk.flow.next(
        executionId,
        stepId,
        CUSTOM_INTERACTIONS.submit,
        {
          transactionId: webauthnTransactionId,
          response,
          cancelWebauthn,
        },
        flowConfig.version
      );
      this.#handleSdkResponse(sdkResp);
    }

    if (action === RESPONSE_ACTIONS.poll) {
      this.#currentInterval = setInterval(async () => {
        const sdkResp = await this.sdk.flow.next(
          executionId,
          stepId,
          CUSTOM_INTERACTIONS.polling,
          {},
          flowConfig.version
        );
        this.#handleSdkResponse(sdkResp);
      }, 2000);
    }

    // if there is no screen id (possibly due to page refresh or no screen flow) we should get it from the server
    if (!screenId && !startScreenId) {
      this.loggerWrapper.warn('No screen was found to show');
      return;
    }

    const readyScreenId = startScreenId || screenId;

    // get the right filename according to the user locale and flow target locales
    const filenameWithLocale: string = await this.getHtmlFilenameWithLocale(
      locale,
      readyScreenId
    );

    // generate step state update data
    const stepStateUpdate: Partial<StepState> = {
      direction: getAnimationDirection(+stepId, +prevState.stepId),
      screenState: {
        ...screenState,
        lastAuth: {
          loginId,
          name: this.sdk.getLastUserDisplayName() || loginId,
        },
      },
      htmlUrl: getContentUrl(projectId, `${readyScreenId}.html`),
      htmlLocaleUrl:
        filenameWithLocale && getContentUrl(projectId, filenameWithLocale),
      samlIdpUsername,
    };

    const lastAuth = getLastAuth(loginId);

    // If there is a start screen id, next action should start the flow
    // But if oidcIdpStateId, samlIdpStateId, samlIdpUsername, ssoAppId is not empty, this optimization doesn't happen
    // because Descope may decide not to show the first screen (in cases like a user is already logged in) - this is more relevant for SSO scenarios
    if (
      showFirstScreenOnExecutionInit(
        startScreenId,
        oidcIdpStateId,
        samlIdpStateId,
        samlIdpUsername,
        ssoAppId
      )
    ) {
      stepStateUpdate.next = (interactionId, inputs) =>
        this.sdk.flow.start(
          flowId,
          {
            tenant,
            redirectAuth,
            oidcIdpStateId,
            samlIdpStateId,
            samlIdpUsername,
            ssoAppId,
            lastAuth,
            preview: this.preview,
            ...(redirectUrl && { redirectUrl }),
          },
          conditionInteractionId,
          interactionId,
          {
            ...inputs,
            ...(code && { exchangeCode: code, idpInitiated: true }),
            ...(token && { token }),
          },
          flowConfig.version
        );
    } else if (
      isChanged('projectId') ||
      isChanged('baseUrl') ||
      isChanged('executionId') ||
      isChanged('stepId')
    ) {
      stepStateUpdate.next = (...args) =>
        this.sdk.flow.next(executionId, stepId, ...args);
    }

    // update step state
    this.stepState.update(stepStateUpdate);
  }

  #resetCurrentInterval = () => {
    clearInterval(this.#currentInterval);
    this.#currentInterval = null;
  };

  #handleSdkResponse = (sdkResp: NextFnReturnPromiseValue) => {
    if (!sdkResp?.ok) {
      this.#resetCurrentInterval();
      this.#dispatch('error', sdkResp?.error);
      const defaultMessage = sdkResp?.response?.url;
      const defaultDescription = `${sdkResp?.response?.status} - ${sdkResp?.response?.statusText}`;

      this.loggerWrapper.error(
        sdkResp?.error?.errorDescription || defaultMessage,
        sdkResp?.error?.errorMessage || defaultDescription
      );
      return;
    }

    const errorText = sdkResp.data?.screen?.state?.errorText;
    if (sdkResp.data?.error) {
      this.loggerWrapper.error(
        `[${sdkResp.data.error.code}]: ${sdkResp.data.error.description}`,
        `${errorText ? `${errorText} - ` : ''}${sdkResp.data.error.message}`
      );
    } else if (errorText) {
      this.loggerWrapper.error(errorText);
    }

    const { status, authInfo, lastAuth } = sdkResp.data;

    if (status === 'completed') {
      setLastAuth(lastAuth);
      this.#resetCurrentInterval();
      this.#dispatch('success', authInfo);
      return;
    }

    const {
      executionId,
      stepId,
      stepName,
      action,
      screen,
      redirect,
      webauthn,
      error,
      samlIdpResponse,
    } = sdkResp.data;

    if (action === RESPONSE_ACTIONS.poll) {
      // We only update action because the polling response action does not return extra information
      this.flowState.update({
        action,
      });
      return;
    }

    this.loggerWrapper.info(
      `Step "${stepName || `#${stepId}`}" is ${status}`,
      '',
      {
        screen,
        status,
        stepId,
        stepName,
        action,
        error,
      }
    );

    this.flowState.update({
      stepId,
      executionId,
      action,
      redirectTo: redirect?.url,
      screenId: screen?.id,
      screenState: screen?.state,
      webauthnTransactionId: webauthn?.transactionId,
      webauthnOptions: webauthn?.options,
      samlIdpResponseUrl: samlIdpResponse?.url,
      samlIdpResponseSamlResponse: samlIdpResponse?.samlResponse,
      samlIdpResponseRelayState: samlIdpResponse?.relayState,
    });
  };

  // we want to get the start params only if we don't have it already
  #getWebauthnConditionalUiStartParams = withMemCache(async () => {
    try {
      const startResp = await this.sdk.webauthn.signIn.start(
        '',
        window.location.origin
      ); // when using conditional UI we need to call start without identifier
      if (!startResp.ok) {
        this.loggerWrapper.error(
          'Webauthn start failed',
          startResp?.error?.errorMessage
        );
      }
      return startResp.data;
    } catch (err) {
      this.loggerWrapper.error('Webauthn start failed', err.message);
    }

    return undefined;
  });

  /**
   * this is needed because Conditional UI does not work on all input names
   * we need to add a prefix to the input name so it will trigger the autocomplete dialog
   * but we want to remove it once the user starts typing because we want this field to be sent to the server with the correct name
   */

  // eslint-disable-next-line class-methods-use-this
  #handleConditionalUiInput(inputEle: HTMLInputElement) {
    const ignoreList = ['email'];
    const origName = inputEle.name;

    if (!ignoreList.includes(origName)) {
      const conditionalUiSupportName = `user-${origName}`;

      // eslint-disable-next-line no-param-reassign
      inputEle.name = conditionalUiSupportName;

      inputEle.addEventListener('input', () => {
        // eslint-disable-next-line no-param-reassign
        inputEle.name = inputEle.value ? origName : conditionalUiSupportName;
      });
    }
  }

  async #handleWebauthnConditionalUi(fragment: DocumentFragment, next: NextFn) {
    this.#conditionalUiAbortController?.abort();

    const conditionalUiInput = fragment.querySelector(
      'input[autocomplete="webauthn"]'
    ) as HTMLInputElement;

    if (conditionalUiInput && (await isConditionalLoginSupported())) {
      const { options, transactionId } =
        (await this.#getWebauthnConditionalUiStartParams()) || {};

      if (options && transactionId) {
        this.#handleConditionalUiInput(conditionalUiInput);

        // we need the abort controller so we can cancel the current webauthn session in case the user clicked on a webauthn button, and we need to start a new session
        this.#conditionalUiAbortController = new AbortController();

        // we should not wait for this fn, it will call next when the user uses his passkey on the input
        this.sdk.webauthn.helpers
          .conditional(options, this.#conditionalUiAbortController)
          .then(async (response) => {
            const resp = await next(conditionalUiInput.id, {
              transactionId,
              response,
            });
            this.#handleSdkResponse(resp);
          })
          .catch((err) => {
            if (err.name !== 'AbortError') {
              this.loggerWrapper.error('Conditional login failed', err.message);
            }
          });
      }
    }
  }

  async onStepChange(currentState: StepState, prevState: StepState) {
    const { htmlUrl, htmlLocaleUrl, direction, next, screenState } =
      currentState;

    const stepTemplate = document.createElement('template');
    stepTemplate.innerHTML = await this.getPageContent(htmlUrl, htmlLocaleUrl);

    const clone = stepTemplate.content.cloneNode(true) as DocumentFragment;

    const scriptFns = generateFnsFromScriptTags(
      clone,
      await this.getExecutionContext()
    );

    // we want to disable the webauthn buttons if it's not supported on the browser
    if (!this.sdk.webauthn.helpers.isSupported()) {
      disableWebauthnButtons(clone);
    } else {
      await this.#handleWebauthnConditionalUi(clone, next);
    }

    if (
      currentState.samlIdpUsername &&
      !screenState.form?.loginId &&
      !screenState.form?.email
    ) {
      if (!screenState.form) {
        screenState.form = {};
      }
      screenState.form.loginId = currentState.samlIdpUsername;
      screenState.form.email = currentState.samlIdpUsername;
    }

    replaceWithScreenState(
      clone,
      screenState,
      this.errorTransformer,
      this.loggerWrapper
    );

    // put the totp variable on the root element, which is the top level 'div'
    setTOTPVariable(clone.querySelector('div'), screenState?.totp?.image);

    const injectNextPage = async () => {
      try {
        scriptFns.forEach((fn) => {
          fn();
        });
      } catch (e) {
        this.loggerWrapper.error(e.message);
      }

      this.rootElement.replaceChildren(clone);

      // If before html url was empty, we deduce its the first time a screen is shown
      const isFirstScreen = !prevState.htmlUrl;

      handleAutoFocus(this.rootElement, this.autoFocus, isFirstScreen);

      this.#hydrate(next);
      this.#dispatch('page-updated', {});
      const loader = this.rootElement.querySelector(
        `[${ELEMENT_TYPE_ATTRIBUTE}="polling"]`
      );
      if (loader) {
        // Loader component in the screen triggers polling interaction
        const response = await next(CUSTOM_INTERACTIONS.polling, {});
        this.#handleSdkResponse(response);
      }
    };

    // no animation
    if (!direction) {
      injectNextPage();
      return;
    }

    this.#handleAnimation(injectNextPage, direction);
  }

  #validateInputs() {
    return Array.from(this.shadowRoot.querySelectorAll('.descope-input')).every(
      (input: HTMLInputElement) => {
        input.reportValidity();
        return input.checkValidity();
      }
    );
  }

  async #getFormData() {
    const inputs = Array.from(
      this.shadowRoot.querySelectorAll(
        `.descope-input[name]:not([${DESCOPE_ATTRIBUTE_EXCLUDE_FIELD}])`
      )
    ) as HTMLInputElement[];

    // wait for all inputs
    const values = await Promise.all(
      inputs.map(async (input) => {
        const value = await getInputValueByType(input);
        return {
          name: input.name,
          value,
        };
      })
    );

    // reduce to object
    return values.reduce(
      (acc, val) => ({
        ...acc,
        [val.name]: val.value,
      }),
      {}
    );
  }

  #handleSubmitButtonLoader(submitter: HTMLButtonElement) {
    const unsubscribeNextRequestStatus = this.nextRequestStatus.subscribe(
      ({ isLoading }) => {
        if (isLoading) {
          submitter?.classList?.add('loading');
        } else {
          this.nextRequestStatus.unsubscribe(unsubscribeNextRequestStatus);
          submitter?.classList?.remove('loading');
        }
      }
    );
  }

  async #handleSubmit(submitter: HTMLButtonElement, next: NextFn) {
    if (submitter.formNoValidate || this.#validateInputs()) {
      const submitterId = submitter?.getAttribute('id');

      this.#handleSubmitButtonLoader(submitter);

      const formData = await this.#getFormData();
      const eleDescopeAttrs = getElementDescopeAttributes(submitter);

      const actionArgs = {
        ...eleDescopeAttrs,
        ...formData,
        // 'origin' is required to start webauthn. For now we'll add it to every request
        origin: window.location.origin,
      };

      const sdkResp = await next(submitterId, actionArgs);

      this.#handleSdkResponse(sdkResp);
    }
  }

  #hydrate(next: NextFn) {
    // hydrating the page
    // Adding event listeners to all buttons without the exclude attribute
    this.rootElement
      .querySelectorAll(
        `button:not([${DESCOPE_ATTRIBUTE_EXCLUDE_NEXT_BUTTON}])`
      )
      .forEach((button: HTMLButtonElement) => {
        // eslint-disable-next-line no-param-reassign
        button.onclick = () => {
          this.#handleSubmit(button, next);
        };
      });
  }

  #handleAnimation(injectNextPage: () => void, direction: Direction) {
    this.rootElement.addEventListener(
      'transitionend',
      () => {
        this.rootElement.classList.remove('fade-out');
        injectNextPage();
      },
      { once: true }
    );

    const transitionClass =
      direction === Direction.forward ? 'slide-forward' : 'slide-backward';

    Array.from(
      this.rootElement.getElementsByClassName('input-container')
    ).forEach((ele, i) => {
      // eslint-disable-next-line no-param-reassign
      (ele as HTMLElement).style['transition-delay'] = `${i * 40}ms`;
      ele.classList.add(transitionClass);
    });

    this.rootElement.classList.add('fade-out');
  }

  #dispatch(eventName: string, detail: any) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}

export default DescopeWc;
