# Contoso Energy — Field Operations Remote Access Guide

**Document Classification:** Internal Use Only
**Department:** IT Operations
**Version:** 2.4
**Last Updated:** May 2026
**Owner:** Contoso Enterprise IT — Field Connectivity Team

---

## 1. Overview and Purpose

This guide provides step-by-step instructions for Contoso Energy field technicians and operations staff who need to access corporate IT systems remotely. Whether you are working from a remote electrical substation, a gas transmission facility, or a temporary field site, this guide covers the tools, procedures, and troubleshooting steps needed to maintain a secure and productive connection to Contoso's enterprise systems.

This guide covers the following systems:

- **Contoso Corporate VPN** (GlobalProtect)
- **Outage Management System (OMS)** — mobile and remote access
- **SCADA System Remote Login** — for authorized personnel only
- **Microsoft 365 Applications** — Outlook, Teams, SharePoint from the field
- **IT Ticketing and Escalation**

> ⚠️ **Safety First:** Field technicians must follow all operational safety procedures before engaging with IT systems at any site. Do not attempt to troubleshoot IT systems if doing so would compromise personal safety or site operations.

---

## 2. Prerequisites

Before attempting to connect remotely from a field site, confirm the following prerequisites are in place:

### 2.1 Device Requirements

| Requirement | Details |
|---|---|
| **Enrolled device** | Your device must be enrolled in Contoso's Microsoft Intune MDM (Mobile Device Management). If your device is not enrolled, contact the IT Operations Helpdesk before your field assignment. |
| **Approved device types** | Panasonic Toughbook CF-54 or CF-33, Dell Latitude Rugged, Samsung Galaxy Tab Active — or any Intune-enrolled corporate laptop or tablet |
| **Operating System** | Windows 10/11 (latest Intune policy patch applied) or iOS/Android with Contoso Mobile enrolled |
| **VPN client installed** | Palo Alto Networks **GlobalProtect** VPN client must be installed. Version 6.2 or later required. |
| **MFA configured** | Microsoft Authenticator app must be installed and your account enrolled in Multi-Factor Authentication (MFA) via Entra ID. |
| **Battery / Power** | Ensure device is sufficiently charged or connected to a power source before initiating remote sessions. |

### 2.2 Network Requirements

| Requirement | Details |
|---|---|
| **Cellular data** | A Contoso-issued mobile hotspot (Cradlepoint IBR900 or equivalent) or a carrier SIM with data enabled |
| **Minimum bandwidth** | 5 Mbps download / 2 Mbps upload for standard remote access; 10 Mbps for OMS and SCADA sessions |
| **Satellite connectivity** | At remote sites without cellular coverage, Starlink Enterprise terminals are deployed. Contact your site supervisor for terminal credentials. |
| **Firewall exceptions** | Outbound TCP ports 443 and 4767 must be open for GlobalProtect. Do not attempt to manually configure firewall settings — contact IT if blocked. |

---

## 3. Connecting to the Contoso Corporate VPN from a Remote Site

Contoso Energy uses **Palo Alto Networks GlobalProtect** as its corporate VPN solution. All access to internal applications, SharePoint, SCADA interfaces, and the OMS from outside a Contoso facility requires an active GlobalProtect VPN connection.

### 3.1 Step-by-Step: Connecting via GlobalProtect (Windows)

1. Ensure your device has a working internet connection (cellular hotspot or site Wi-Fi).
2. Open the **GlobalProtect** application from the system tray (orange globe icon near the clock).
3. If prompted for a **Portal Address**, enter: `vpn.contoso.com`
4. Click **Connect**.
5. The **Sign In** screen will appear. Enter your **Contoso email address** (e.g., `jsmith@contoso.com`) and your **network password**.
6. You will receive a push notification on your **Microsoft Authenticator** app. Approve the sign-in request. Do not approve requests you did not initiate.
7. GlobalProtect will show **Connected** with a green checkmark once the tunnel is established.
8. You can now access internal Contoso resources.

> **Tip:** If you do not receive an MFA push notification within 30 seconds, open the Authenticator app manually and approve the pending request. If no request appears, select **Sign in another way** and choose **Use verification code**.

### 3.2 Step-by-Step: Connecting via GlobalProtect (Mobile — iOS/Android)

1. Open the **GlobalProtect** app (available from the Company Portal).
2. Tap **Connect**.
3. If prompted for a portal address, enter: `vpn.contoso.com`
4. Sign in with your Contoso credentials and approve the MFA prompt.
5. The app will display **VPN Connected** once the tunnel is active.

### 3.3 VPN Gateway Selection

GlobalProtect automatically selects the optimal VPN gateway based on your location. Contoso operates VPN gateways in the following regions:

| Gateway | Primary Region |
|---|---|
| `ca-vpn.contoso.com` | California (SDG&E / SoCalGas sites) |
| `tx-vpn.contoso.com` | Texas (Oncor / Contoso Texas sites) |
| `az-vpn.contoso.com` | Arizona and Southwest |

If you experience slow performance, you may manually select your regional gateway in GlobalProtect settings under **Gateway**.

---

## 4. Accessing the Outage Management System (OMS) from the Field

The **Contoso Outage Management System (OMS)** is used by field crews and control room operators to view, report, and manage power outages in real time. Field technicians may access OMS in read-only mode from the field to review outage tickets assigned to them.

### 4.1 OMS Web Access

> **VPN Required:** You must be connected to the Contoso GlobalProtect VPN before accessing OMS.

1. Ensure GlobalProtect VPN is connected (see Section 3).
2. Open a supported browser (Microsoft Edge or Chrome).
3. Navigate to: `https://oms.internal.contoso.com`
4. Sign in with your **Contoso network credentials** (same as your email login).
5. MFA will be required. Approve the push notification on Microsoft Authenticator.
6. The OMS dashboard will load. Field technicians will see only outage tickets within their assigned territory or crew.

### 4.2 OMS Mobile App (iOS/Android)

The **Contoso Field OMS** mobile app is available for authorized field technicians and is distributed via the **Microsoft Company Portal** app.

1. Open **Microsoft Company Portal** on your device.
2. Locate and install **Contoso Field OMS**.
3. Launch the app and sign in with your Contoso credentials.
4. Approve the MFA prompt.
5. The app will synchronize your assigned outage tickets automatically.

> **Note:** The OMS mobile app requires an active internet connection but does **not** require GlobalProtect VPN — it uses the Contoso Cloud Gateway (Azure AD Application Proxy) for secure access without a full VPN tunnel.

### 4.3 Offline Mode

If you lose connectivity in the field:

- The OMS mobile app will enter **Offline Mode** automatically.
- You can view the last synchronized set of outage tickets and add notes.
- Notes will sync automatically when connectivity is restored.
- Do **not** attempt to close or clear open tickets while offline — changes may not sync correctly.

---

## 5. SCADA System Remote Login Procedure

> ⚠️ **IMPORTANT — NERC CIP Notice:** SCADA systems at Contoso Energy operate within **NERC CIP-regulated Electronic Security Perimeters (ESPs)**. Remote access to SCADA systems is strictly controlled and audited. Only personnel with a current **CIP-005 Remote Access Authorization** on file with the Cyber Security team may connect remotely to SCADA systems.

### 5.1 Authorized Remote Access Methods

Contoso Energy field personnel with active CIP-005 authorization may access SCADA systems remotely via:

1. **Contoso Secure OT VPN** — a separate VPN tunnel from the standard corporate VPN, used exclusively for OT network access.
2. **Jump Server (Bastion Host)** — a dedicated intermediary server that provides controlled access to SCADA HMI interfaces.

**Standard corporate GlobalProtect VPN does NOT provide access to SCADA systems.** SCADA access requires the dedicated OT VPN.

### 5.2 Step-by-Step: SCADA Remote Login

> **Prerequisites:** CIP-005 authorization on file, OT VPN client installed, hardware token issued by Cyber Security.

1. Disconnect from the standard GlobalProtect VPN if connected.
2. Open the **Contoso OT VPN** client (a separate application from GlobalProtect, labeled "Contoso OT Access").
3. Enter the OT VPN portal address: `ot-vpn.contoso.com`
4. Enter your **OT credentials** (note: these are different from your standard Contoso network credentials).
5. When prompted, enter the 6-digit code from your **RSA hardware token**.
6. Once connected, open the **Remote Desktop Connection** application (`mstsc`).
7. Connect to the assigned **Jump Server** address provided by the Cyber Security team (e.g., `jumpserver-west.ot.contoso.com`).
8. Log in with your OT credentials.
9. From the Jump Server, open the SCADA HMI application assigned to your role.

### 5.3 Ending a SCADA Remote Session

- Always log out of the SCADA HMI application before closing the Remote Desktop session.
- Disconnect the Remote Desktop session (do not simply close the window, as the session remains active).
- Disconnect the OT VPN tunnel from the system tray.
- Log the session end time in the **OT Access Log** SharePoint list if required by your site's CIP procedures.

---

## 6. Troubleshooting Common Remote Access Issues

### 6.1 VPN Will Not Connect

| Symptom | Suggested Resolution |
|---|---|
| "Portal not reachable" or "Cannot connect to server" | Check internet connectivity. Try loading `https://www.google.com` in a browser. If no internet, troubleshoot your hotspot or satellite terminal. |
| "Invalid username or password" | Verify you are using your Contoso email address and current network password. If your password has expired, use a phone or a site with internet to reset at `https://myaccount.contoso.com`. |
| MFA push notification not received | Open Microsoft Authenticator manually and check for a pending approval. If no request exists, wait 60 seconds and try again. Alternatively, use a one-time code from Authenticator. |
| VPN connects but cannot reach internal sites | Your device may have a stale certificate. Disconnect VPN, restart GlobalProtect, and reconnect. If the issue persists, call IT Operations. |
| GlobalProtect shows "Connected" but OMS or SharePoint will not load | Force-close and reopen the target application or browser. Clear the browser cache. Disconnect and reconnect VPN. |

### 6.2 OMS Not Loading or Showing Errors

| Symptom | Suggested Resolution |
|---|---|
| "Access Denied" or "403 Forbidden" | Confirm you are connected to GlobalProtect VPN. If connected, your OMS role permissions may have expired — contact your supervisor to verify access. |
| OMS loads but shows blank outage list | Check that your crew assignment is current in the HR system. Contact your dispatcher or shift supervisor. |
| OMS mobile app crashes on launch | Force-close the app and reopen. If it continues, reinstall via Company Portal. Ensure your device OS is on the latest Intune-approved version. |
| Offline mode not syncing when connectivity restored | Force a manual sync by pulling down on the outage list in the mobile app. If sync fails, log out and log back in. |

### 6.3 Microsoft 365 Applications (Outlook, Teams, SharePoint)

| Symptom | Suggested Resolution |
|---|---|
| Cannot sign in to Teams or Outlook | Check that your Contoso account has not been locked. Sign in at `https://myaccount.contoso.com` to verify. |
| Teams calls dropping or poor quality | Move to a higher-signal area. Switch from cellular to Wi-Fi if available. Reduce video quality in Teams settings. |
| SharePoint site not loading | Confirm VPN is connected for internal SharePoint sites. External SharePoint sites (with `sharepoint.com` in the URL) do not require VPN. |

---

## 7. Escalation Path

If you cannot resolve a remote access issue using this guide, follow the escalation path below:

### 7.1 Level 1 — Self-Service

- Consult this guide (Contoso Field Operations Remote Access Guide).
- Check the **Contoso IT Operations SharePoint** site for latest known issues and status updates.
- Try basic troubleshooting (restart device, reconnect VPN, clear browser cache).

### 7.2 Level 2 — IT Operations Helpdesk

- **Phone:** 1-800-CONTOSO-IT (1-800-736-7248) — available 24/7 for field crew
- **Teams Channel:** `#it-field-ops` (if you have Teams connectivity)
- **Email:** `it-helpdesk@contoso.com` (response within 4 hours during business hours)
- **Provide the following when you call:** Employee ID, device type, location/site name, system you are trying to access, exact error message displayed, and steps already tried.

### 7.3 Level 3 — Cyber Security (SCADA/OT Issues Only)

For issues specifically related to **OT VPN, SCADA access, or CIP-005 authorization**:

- **Phone:** 1-866-CONTOSO-OT (available 24/7 for OT-related security incidents)
- **Email:** `ot-security@contoso.com`
- Do not attempt to work around OT access controls. Report any access issues or anomalies immediately.

### 7.4 NERC CIP Cybersecurity Incident Reporting

If you observe or suspect a **cybersecurity incident** involving critical infrastructure systems:

1. **Do not** attempt to contain or investigate it yourself.
2. **Immediately** contact the Contoso Cyber Security Operations Center (CSOC):
   - **Phone (24/7):** 1-866-CONTOSO-CSOC
   - **Email:** `csoc@contoso.com`
3. Provide: your name, location, time of observation, system involved, and a brief description of what you observed.
4. Preserve any evidence (do not power off the affected device unless directed by CSOC).
5. Document the incident in the **NERC CIP Incident Log** (accessible via the Contoso IT Operations SharePoint when connectivity permits).

---

## Appendix A — Quick Reference Card

| Task | How |
|---|---|
| Connect to Corporate VPN | Open GlobalProtect → Connect → `vpn.contoso.com` → MFA approve |
| Access OMS (browser) | VPN connected → `https://oms.internal.contoso.com` |
| Access OMS (mobile) | Company Portal → Contoso Field OMS app |
| SCADA remote access | OT VPN → Jump Server → HMI (authorized personnel only) |
| Reset network password | `https://myaccount.contoso.com` |
| IT Helpdesk (24/7) | 1-800-CONTOSO-IT |
| OT Security (24/7) | 1-866-CONTOSO-OT |
| Cybersecurity Incident | 1-866-CONTOSO-CSOC |

---

## Appendix B — Approved Remote Access Devices

| Device | Type | VPN Support | OMS Mobile | SCADA OT VPN |
|---|---|---|---|---|
| Panasonic Toughbook CF-54 | Rugged Laptop | ✅ | ✅ (browser) | ✅ (authorized only) |
| Panasonic Toughbook CF-33 | Rugged Tablet/Laptop | ✅ | ✅ | ✅ (authorized only) |
| Dell Latitude 5430 Rugged | Laptop | ✅ | ✅ (browser) | ✅ (authorized only) |
| Samsung Galaxy Tab Active4 Pro | Android Tablet | ✅ (mobile) | ✅ (app) | ❌ |
| Apple iPhone (Corporate) | Smartphone | ✅ (mobile) | ✅ (app) | ❌ |

Personal devices are not supported for any Contoso remote access. If you are working from a personal device in an emergency, contact the IT Helpdesk for a temporary access exception.

---

*This document is maintained by the Contoso Enterprise IT — Field Connectivity Team. For corrections or updates, contact `it-docs@contoso.com`.*

*© 2026 Contoso. Internal Use Only. Do not distribute outside of Contoso Energy or its subsidiaries.*
