# Comunicaciones pendientes

Dos trámites con terceros que el proyecto debe a día de hoy. Los borradores están
abajo, **sin enviar**.

Uno de los dos va con retraso y conviene decirlo sin rodeos: el *Règlement
d'usage* del Nutri-Score exige la solicitud *«avant tout usage»* y la aplicación
ya está desplegada mostrando el logotipo. No es un descuido, fue una decisión
explícita de implementar antes de cursarla, pero el retraso existe y el borrador
lo reconoce en vez de disimularlo.

---

## 1 · Nutri-Score — derecho de uso para editores de software

**A:** `nutriscore@santepubliquefrance.fr`
**Idioma:** francés (es la lengua del reglamento y del titular de la marca)
**Estado:** pendiente de enviar

### Por qué a Santé publique France y no a otro sitio

La marca es suya. Su página remite a dos plataformas de registro
(`demarches-simplifiees.fr`), pero **ésas son para fabricantes que ponen el
logotipo en el envase**, no para editores de software: piden marcas, gamas de
productos y el compromiso de etiquetar todo el catálogo. Nada de eso aplica.

Para nuestro caso el reglamento abre una vía distinta, el **artículo 4.1**:

> *«Par exception, les éditeurs de logiciels et d'applications disposent d'un
> droit d'usage de la Marque Nutri-Score à des fins […] d'information du
> public.»*

con la condición de solicitud previa por correo al regulador competente del
territorio.

**Y ahí hay un hueco real:** Santé publique France publica contactos nacionales
para Bélgica (`nutri-score@health.fgov.be`), Suiza, Luxemburgo y Alemania.
**España no aparece**, y los países latinoamericanos cuyos catálogos servimos no
han adoptado el Nutri-Score en absoluto. Por eso el borrador se dirige al titular
de la marca y le pregunta explícitamente si es el destinatario correcto o si debe
redirigirnos.

### Borrador

> Objet : Demande de droit d'usage de la Marque Nutri-Score — éditeur
> d'application (article 4.1 du Règlement d'usage)
>
> Madame, Monsieur,
>
> *Précision préalable : ma langue principale est l'espagnol. Ce courrier a été
> rédigé en français avec l'aide d'outils d'intelligence artificielle. Si une
> tournure vous paraît maladroite ou ambiguë, il s'agit de la traduction et non
> de l'intention. Je peux poursuivre l'échange en espagnol ou en anglais si cela
> vous est plus commode.*
>
> Je vous écris au titre de l'article 4.1 du Règlement d'usage de la Marque
> Nutri-Score (édition de mars 2025), qui ouvre aux éditeurs de logiciels et
> d'applications un droit d'usage à des fins d'information du public.
>
> **L'application.** Veskan est une application web libre (licence AGPL-3.0),
> sans but lucratif et sans publicité, qui affiche l'information nutritionnelle
> d'un produit à partir de son code-barres. Elle fonctionne entièrement dans le
> navigateur, sans serveur. Les données proviennent d'Open Food Facts
> (ODbL-1.0). Elle est publiée à l'adresse https://jmtt89.github.io/veskan et
> son code est public : https://github.com/jmtt89/veskan
>
> **L'usage que nous en faisons.** L'application affiche le logotype officiel
> Nutri-Score, dans sa version neutre 240×130, servi depuis nos propres fichiers
> et **tel quel** : sans recoloration, sans filtre — y compris en mode sombre —,
> sans recadrage et en conservant les proportions, conformément à l'Annexe 2
> (Charte graphique). Nous n'avons pas redessiné le logotype : nous utilisons
> les fichiers officiels, précisément parce que les couleurs réelles de la
> marque ne correspondent pas à celles que citent couramment les articles de
> vulgarisation.
>
> Nous ne développons ni n'utilisons aucun signe similaire, conformément à
> l'article 8.2.
>
> **Un point que je tiens à signaler.** L'application calcule également le
> Nutri-Score elle-même, selon l'algorithme 2023, lorsque la valeur n'est pas
> disponible dans la source de données. Le résultat est alors présenté comme un
> calcul de notre part et distingué visuellement de la note publiée par le
> fabricant. Si cet usage appelle des conditions particulières, merci de me
> l'indiquer.
>
> **Sur le territoire concerné.** L'application est en espagnol et couvre des
> catalogues de produits d'Espagne et d'Amérique latine. Votre site publie des
> contacts nationaux pour la Belgique, la Suisse, le Luxembourg et l'Allemagne,
> mais pas pour l'Espagne. Je m'adresse donc au titulaire de la marque : si un
> autre organisme est compétent pour ce territoire, je vous serais reconnaissant
> de me l'indiquer et j'adresserai la demande à qui de droit.
>
> **Enfin, par honnêteté :** l'application est déjà en ligne avec le logotype,
> avant l'envoi de cette demande. C'était une décision de ma part, prise en
> connaissance de l'exigence d'antériorité posée par l'article 4.1, et je la
> régularise ici. Si vous estimez que l'usage doit être suspendu en attendant
> votre réponse, dites-le-moi et je retirerai le logotype sans délai.
>
> Je reste à votre disposition pour tout élément complémentaire.
>
> Cordialement,
> Jesús Torres

### Qué hay que decidir antes de enviarlo

- **La dirección de remite.** El repositorio no lleva ninguna dirección de correo
  a propósito, y esto obliga a dar una. La del proyecto es `jmtt89@gmail.com`.
- **Si se retira el logotipo mientras tanto.** El borrador ofrece hacerlo. Es una
  oferta real: si se envía, hay que estar dispuesto a cumplirla.

---

## 2 · Open Food Facts — alta de cliente OIDC

**Dónde:** incidencia en `github.com/openfoodfacts/openfoodfacts-server`, o el
canal `#api` de su Slack
**Idioma:** inglés
**Estado:** pendiente de enviar

### Por qué hace falta

Sin cliente OIDC la aplicación es de **sólo lectura**. No es una limitación
técnica: está verificado (2026-09-16) que el proveedor de OFF está en producción,
soporta `authorization_code` con PKCE S256 —o sea, sirve para una aplicación de
navegador sin secretos— y que la API de escritura **ya acepta el token**:
`API.pm::process_auth_header` lee la cabecera Bearer, la valida contra el JWKS de
Keycloak y resuelve `oidc_user_id`.

Lo que falta es administrativo: *«No clients are pre-configured in the production
and staging instances»*.

Merece la pena señalarles algo: **su propia documentación va por detrás de su
implementación**. La guía de la API dice que OIDC *«will be supported in the
future»*, cuando el servidor ya lo valida. Decírselo ayuda a que la petición se
entienda.

### Borrador

> **Title:** Request for an OIDC client registration for a browser-based
> read/write application
>
> Hello,
>
> I'm asking for an OIDC client to be registered so that a browser application
> can let its users contribute to Open Food Facts with their own accounts.
>
> **The application.** Veskan is a free, non-commercial, ad-free web app
> (AGPL-3.0) that scores a product's nutritional quality from its barcode. It
> runs entirely in the browser, with no server of its own. Source:
> https://github.com/jmtt89/veskan — live at https://jmtt89.github.io/veskan
>
> **What I'm asking for.** A public OIDC client for
> `auth.openfoodfacts.org` (realm `openfoodfacts`), suitable for a browser app:
>
> - grant type: `authorization_code` with PKCE, method S256
> - no client secret (public client)
> - redirect URI: `https://jmtt89.github.io/veskan/` (plus
>   `http://localhost:5173/` for development, if that is acceptable)
> - scopes: whatever is needed to write product data on behalf of the user
>
> **Why I believe everything else is already in place.** I checked this against
> your production instance on 2026-09-16:
>
> - the provider is live and supports `authorization_code` + PKCE S256, so a
>   browser app with no secret is viable;
> - the write API already accepts the token —
>   `API.pm::process_auth_header` reads the Bearer header, validates it against
>   the Keycloak JWKS and resolves `oidc_user_id`.
>
> The only thing missing seems to be the client registration itself, since *"No
> clients are pre-configured in the production and staging instances"*.
>
> **A small thing you may want to know:** your API guide
> (`openfoodfacts.github.io/openfoodfacts-server/api/`) still says that
> OIDC-based authentication *"will be supported in the future"*, which is behind
> what the server already does. That may be worth updating — it's what made me
> verify it against the code rather than take the docs at face value.
>
> Until this exists the app is read-only, and every product page links to Open
> Food Facts so that anyone wanting to contribute can do it on your site.
>
> Happy to move this to the `#api` Slack channel if that's the better place.
>
> Thanks for your work on the project.

### Qué hay que decidir antes de enviarlo

- **Incidencia pública o Slack.** Una incidencia queda registrada y es
  rastreable; Slack es más rápido pero se pierde. Recomiendo la incidencia.
- **Que una incidencia es pública para siempre.** Lleva las URL de despliegue y
  el nombre de usuario de GitHub, que ya son públicos. No lleva correo.

---

## Nada de esto se ha enviado

Los dos borradores están aquí para revisarse y editarse. El de Nutri-Score
compromete a retirar el logotipo si lo piden; el de OFF es público y permanente.
Ninguna de las dos cosas se hace sin decidirlo.
