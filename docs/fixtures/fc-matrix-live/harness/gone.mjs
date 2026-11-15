import { tq, dq } from './lib.mjs';
const T = { CustomField: "DeveloperName LIKE 'SFTK_MX%'", ValidationRule: "ValidationName LIKE 'SFTK_MX%'", WorkflowRule: "Name LIKE 'SFTK_MX%'", WorkflowFieldUpdate: "Name LIKE 'SFTK MX%'",
  FlowDefinition: "DeveloperName LIKE 'SFTK_MX%'", Layout: "Name LIKE 'SFTK MX%'", FlexiPage: "DeveloperName LIKE 'SFTK_MX%'", ListView: "DeveloperName LIKE 'SFTK_MX%'",
  CompactLayout: "DeveloperName LIKE 'SFTK_MX%'", FieldSet: "DeveloperName LIKE 'SFTK_MX%'", WebLink: "Name LIKE 'SFTK_MX%'", QuickActionDefinition: "DeveloperName LIKE 'SFTK_MX%'" };
for (const [o, w] of Object.entries(T)) { try { console.log(o, tq(`SELECT Id FROM ${o} WHERE ${w}`).length); } catch (e) { console.log(o, 'query failed', String(e).slice(0, 120)); } }
for (const [o, w] of Object.entries({ Report: "DeveloperName LIKE 'SFTK_MX%'", EmailTemplate: "DeveloperName LIKE 'SFTK_MX%'", Folder: "DeveloperName LIKE 'SFTK_MX%'", PermissionSet: "Name LIKE 'SFTK_MX%'", ProcessDefinition: "DeveloperName LIKE 'SFTK_MX%'" }))
  { try { console.log(o, dq(`SELECT Id FROM ${o} WHERE ${w}`).length); } catch (e) { console.log(o, 'query failed', String(e).slice(0, 120)); } }
