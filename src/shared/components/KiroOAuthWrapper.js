"use client";

import { useState, useCallback, useEffect } from "react";
import PropTypes from "prop-types";
import OAuthModal from "./OAuthModal";
import KiroAuthModal from "./KiroAuthModal";
import KiroSocialOAuthModal from "./KiroSocialOAuthModal";

/**
 * Kiro OAuth Wrapper
 * Orchestrates between method selection, device code flow, and social login flow.
 *
 * Entry style:
 *  - Provider detail page: no `initialFlow` → shows the method-selection list first.
 */
export default function KiroOAuthWrapper({
  isOpen,
  providerInfo,
  onSuccess,
  onClose,
  initialFlow = null,
}) {
  const [authMethod, setAuthMethod] = useState(null); // null | "builder-id" | "idc" | "social" | "import"
  const [socialProvider, setSocialProvider] = useState(null); // "google" | "github"
  const [idcConfig, setIdcConfig] = useState(null);
  const [importStep, setImportStep] = useState(null); // preset step for KiroAuthModal

  // Apply the preset flow from the automation panel each time the modal opens.
  // `initialFlow.key` changes per launch so re-clicking the same option re-applies.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen) return;
    if (!initialFlow) {
      // Provider-detail entry: always start on the method-selection list.
      setAuthMethod(null);
      setSocialProvider(null);
      setIdcConfig(null);
      setImportStep(null);
      return;
    }

    const { method, provider } = initialFlow;

    if (method === "import") {
      // bulk-token / single-token → KiroAuthModal's paste-token step.
      setAuthMethod("import");
      setImportStep("import");
    } else if (method === "builder-id") {
      setAuthMethod("builder-id");
    } else if (method === "idc") {
      // Needs the start-URL/region form first → open KiroAuthModal on its IDC step.
      setAuthMethod("import");
      setImportStep("idc");
    } else if (method === "social") {
      setAuthMethod("social");
      setSocialProvider(provider || "google");
    }
  }, [isOpen, initialFlow]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleMethodSelect = useCallback((method, config) => {
    if (method === "builder-id") {
      // Use device code flow (AWS Builder ID)
      setAuthMethod("builder-id");
    } else if (method === "idc") {
      // Use device code flow with IDC config
      setAuthMethod("idc");
      setIdcConfig(config);
    } else if (method === "social") {
      // Use social login with manual callback
      setAuthMethod("social");
      setSocialProvider(config.provider);
    } else if (method === "import" || method === "api-key" || method === "import-cli-proxy") {
      // Import / API-key handled in KiroAuthModal, just refresh + close.
      onSuccess?.();
      onClose?.();
    }
  }, [onSuccess, onClose]);

  const handleBack = () => {
    // With a preset flow there's no method list to fall back to — just close.
    if (initialFlow) {
      onClose?.();
      return;
    }
    setAuthMethod(null);
    setSocialProvider(null);
    setIdcConfig(null);
    setImportStep(null);
  };

  const handleSocialSuccess = () => {
    setAuthMethod(null);
    setSocialProvider(null);
    onSuccess?.();
    onClose?.(); // Close modal after success
  };

  const handleDeviceSuccess = () => {
    setAuthMethod(null);
    setIdcConfig(null);
    onSuccess?.();
    onClose?.(); // Close modal after success
  };

  // Method selection (or a preset import/idc step via initialMethod).
  if (!authMethod || authMethod === "import") {
    return (
      <KiroAuthModal
        isOpen={isOpen}
        initialMethod={importStep}
        onMethodSelect={handleMethodSelect}
        onClose={handleBack}
      />
    );
  }

  // Show device code flow (Builder ID or IDC)
  if (authMethod === "builder-id" || authMethod === "idc") {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="kiro"
        providerInfo={providerInfo}
        onSuccess={handleDeviceSuccess}
        onClose={handleBack}
        idcConfig={idcConfig}
      />
    );
  }

  // Show social login flow (Google/GitHub with manual callback)
  if (authMethod === "social" && socialProvider) {
    return (
      <KiroSocialOAuthModal
        isOpen={isOpen}
        provider={socialProvider}
        onSuccess={handleSocialSuccess}
        onClose={handleBack}
      />
    );
  }

  return null;
}

KiroOAuthWrapper.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.shape({
    name: PropTypes.string,
  }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
  initialFlow: PropTypes.shape({
    method: PropTypes.string,
    provider: PropTypes.string,
    key: PropTypes.number,
  }),
};
