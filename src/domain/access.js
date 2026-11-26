const views = {
  owner: ['dashboard', 'orders', 'menu', 'customers', 'expenses', 'reports', 'staff', 'settings'],
  staff: ['pos', 'orders', 'customers', 'expenses']
};

export const canOpen = (role, view) => views[role]?.includes(view) ?? false;
export const homeView = role => views[role][0];
