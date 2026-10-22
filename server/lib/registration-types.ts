/**
 * Business registration types for the Business KYC upgrade flow.
 *
 * CAC = Nigeria's Corporate Affairs Commission. Types prefixed `cac_` require
 * the standard CAC document pack (certificate, application status printout,
 * MEMART, tax printout, proof of address). All other types require the
 * generic registration document pack instead (registration certificate,
 * tax printout, proof of address).
 */

export interface KycDocumentRequirement {
  /** Stable id used in uploads (matches the `kind` field of each document). */
  id: string;
  label: string;
  description: string;
  required: boolean;
}

export interface BusinessRegistrationType {
  id: string;
  label: string;
  authority: string;
  /** CAC pack or generic pack. */
  docPack: "cac" | "generic";
  description: string;
}

export const CAC_DOCUMENTS: KycDocumentRequirement[] = [
  {
    id: "cac_certificate",
    label: "CAC Certificate",
    description: "Certificate of Incorporation / Registration issued by the CAC",
    required: true,
  },
  {
    id: "cac_status_report",
    label: "CAC Application Status",
    description: "CAC status report / application status printout for the entity",
    required: true,
  },
  {
    id: "cac_memart",
    label: "CAC Memorandum (MEMART)",
    description: "Memorandum and Articles of Association of the company",
    required: true,
  },
  {
    id: "tax_printout",
    label: "Tax Printout",
    description: "Recent tax clearance certificate or tax printout",
    required: true,
  },
  {
    id: "proof_of_address",
    label: "Recent Proof of Address",
    description: "Utility bill, bank statement or tenancy agreement (last 3 months)",
    required: true,
  },
];

export const GENERIC_DOCUMENTS: KycDocumentRequirement[] = [
  {
    id: "reg_certificate",
    label: "Registration Document",
    description: "Certificate or official proof of registration for your business",
    required: true,
  },
  {
    id: "tax_printout",
    label: "Tax Printout",
    description: "Recent tax clearance certificate or tax printout",
    required: true,
  },
  {
    id: "proof_of_address",
    label: "Recent Proof of Address",
    description: "Utility bill, bank statement or tenancy agreement (last 3 months)",
    required: true,
  },
];

export const BUSINESS_REGISTRATION_TYPES: BusinessRegistrationType[] = [
  {
    id: "cac_bn",
    label: "Business Name (BN)",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "Sole-proprietor business registered with the Corporate Affairs Commission.",
  },
  {
    id: "cac_ltd",
    label: "Private Company Limited by Shares (LTD)",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "A private limited liability company (Ltd) incorporated at the CAC.",
  },
  {
    id: "cac_plc",
    label: "Public Limited Company (PLC)",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "A public limited company whose shares may be publicly offered.",
  },
  {
    id: "cac_gte",
    label: "Company Limited by Guarantee (LTD/GTE)",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "Non-profit-oriented company (foundations, charities, associations).",
  },
  {
    id: "cac_it",
    label: "Incorporated Trustees",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "NGOs, churches, mosques and other trustee-managed organisations.",
  },
  {
    id: "cac_lp",
    label: "Limited Partnership (LP)",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "Partnership with at least one general and one limited partner.",
  },
  {
    id: "cac_llp",
    label: "Limited Liability Partnership (LLP)",
    authority: "CAC (Nigeria)",
    docPack: "cac",
    description: "Hybrid partnership where all partners enjoy limited liability.",
  },
  {
    id: "sole_proprietorship",
    label: "Sole Proprietorship (Trade Licence)",
    authority: "State / Local authority",
    docPack: "generic",
    description: "Unincorporated business operating under a state trade licence or permit.",
  },
  {
    id: "general_partnership",
    label: "General Partnership",
    authority: "State / Local authority",
    docPack: "generic",
    description: "Two or more persons carrying on business together under an agreement.",
  },
  {
    id: "foreign_registration",
    label: "Foreign Registered Entity",
    authority: "Home country registry",
    docPack: "generic",
    description: "Company incorporated outside Nigeria (certificate of incorporation abroad).",
  },
  {
    id: "other",
    label: "Other",
    authority: "Other registry",
    docPack: "generic",
    description: "Any other registration type — provide your own registration documents.",
  },
];

export function getRegistrationType(id: string): BusinessRegistrationType | undefined {
  return BUSINESS_REGISTRATION_TYPES.find((t) => t.id === id);
}

export function getRequiredDocuments(typeId: string): KycDocumentRequirement[] | null {
  const type = getRegistrationType(typeId);
  if (!type) return null;
  return type.docPack === "cac" ? CAC_DOCUMENTS : GENERIC_DOCUMENTS;
}

/** Client-facing config payload for /business-kyc/config */
export function registrationTypesConfig() {
  return BUSINESS_REGISTRATION_TYPES.map((t) => {
    const docs = t.docPack === "cac" ? CAC_DOCUMENTS : GENERIC_DOCUMENTS;
    return {
      id: t.id,
      label: t.label,
      authority: t.authority,
      docPack: t.docPack,
      description: t.description,
      documents: docs,
    };
  });
}
