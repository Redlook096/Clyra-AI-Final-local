export type BrowserPermissionScope = "once" | "task" | "project";

export type BrowserPermissionRequest = {
  projectId: string;
  origin: string;
  action: "download" | "upload" | "external_navigation" | "sensitive_input" | "destructive_action";
};

/** In-memory permission decisions are intentionally explicit; callers must ask UI before allowing protected actions. */
export class BrowserPermissions {
  private static granted = new Map<string, BrowserPermissionScope>();

  static key(request: BrowserPermissionRequest) {
    return `${request.projectId}:${request.origin}:${request.action}`;
  }

  static requestPermission(_request: BrowserPermissionRequest): Promise<boolean> {
    return Promise.resolve(false);
  }

  static grant(request: BrowserPermissionRequest, scope: BrowserPermissionScope) {
    this.granted.set(this.key(request), scope);
  }

  static revoke(request: BrowserPermissionRequest) {
    this.granted.delete(this.key(request));
  }

  static isAllowed(request: BrowserPermissionRequest): boolean {
    return this.granted.has(this.key(request));
  }
}
