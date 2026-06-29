import {redirect, Form, useLoaderData} from 'react-router';

import {login} from '../../shopify.server';

import styles from './styles.module.css';

export const loader = async ({request}) => {
  const url = new URL(request.url);

  if (url.searchParams.get('shop')) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return {showForm: Boolean(login)};
};

export default function App() {
  const {showForm} = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>ShopifyQL sales dashboard</h1>
        <p className={styles.text}>
          Run a ShopifyQL query with the GraphQL Admin API and render the results
          in the Shopify admin.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}
